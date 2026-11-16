#!/usr/bin/env node
/**
 * refresh-pulse-and-pins.mjs
 *
 * 每日定时任务：
 * 1. 撤下 `pin_until <= now` 的置顶（条目本体保留，回到普通新品流），重排 pin_order；
 * 2. 刷新在架项目的 stars / forks / latest_version / 讨论评论数与顶帖数
 *    （GitHub 仓库与讨论用单次别名 GraphQL 每批 25 个；其他托管源走公开 REST）；
 * 3. 维护 state/stars-history.json（近 14 天每日快照）并计算 stars_7d_delta；
 * 4. 仅在实质变化时写盘，并向 $GITHUB_OUTPUT 写出 `changed=true|false`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatJson, isoNow } from './lib/shared.mjs';
import { graphql, rest } from './lib/github.mjs';
import { dropExpiredPins } from './publish-launch.mjs';
import { validateLaunchpad } from './validate-launchpad.mjs';

export const HISTORY_DAYS = 14;
export const DELTA_WINDOW_DAYS = 7;
export const GRAPHQL_BATCH = 25;

export function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * 星数与最近一次快照不同时才写入今日快照（快照代表「自该日起的星数」），
 * 并只保留最近 `HISTORY_DAYS` 天；无变化的日子零写盘。
 */
export function updateStarsHistory(history, starsById, today) {
  const prevDays = history?.days ?? {};
  const latest = Object.keys(prevDays).filter((d) => d <= today).sort().pop();
  const same = latest !== undefined && JSON.stringify(sortKeys(prevDays[latest])) === JSON.stringify(sortKeys(starsById));
  const days = same ? { ...prevDays } : { ...prevDays, [today]: { ...starsById } };
  const all = Object.keys(days).filter((d) => dayDiff(today, d) >= 0).sort();
  // 窗口外仍保留最近一份 ≥7 天的快照作为涨星基线（快照只在变化时写入，它可能早于 14 天）。
  const anchor = all.filter((d) => dayDiff(today, d) >= DELTA_WINDOW_DAYS).pop();
  const kept = all.filter((d) => dayDiff(today, d) < HISTORY_DAYS || d === anchor);
  return { version: 1, days: Object.fromEntries(kept.map((d) => [d, days[d]])) };
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/** 相对 7 天前（不足 7 天取最早快照）的涨星，负数归零。 */
export function computeDelta(history, id, currentStars, today) {
  const candidates = Object.keys(history?.days ?? {})
    .filter((d) => d !== today && typeof history.days[d]?.[id] === 'number')
    .sort();
  if (!candidates.length) return 0;
  const target = candidates.filter((d) => dayDiff(today, d) >= DELTA_WINDOW_DAYS).pop() ?? candidates[0];
  return Math.max(0, currentStars - history.days[target][id]);
}

/** 合并统计到条目；返回 `{ items, changed }`。 */
export function applyStats(items, statsById) {
  let changed = false;
  const next = items.map((item) => {
    const s = statsById[item.id];
    if (!s) return item;
    const merged = { ...item };
    for (const key of ['stars', 'forks', 'latest_version', 'discussion_comments_count', 'discussion_upvotes', 'stars_7d_delta']) {
      if (s[key] !== undefined && s[key] !== null && s[key] !== '' && merged[key] !== s[key]) {
        merged[key] = s[key];
        changed = true;
      }
    }
    return merged;
  });
  return { items: next, changed };
}

/** 置顶到期撤下 + 统计合并 + 涨星计算（纯函数）。 */
export function refreshManifest(manifest, history, statsById, nowMs) {
  const pinned = dropExpiredPins(manifest.pinned ?? [], nowMs);
  const pinsChanged = JSON.stringify(pinned) !== JSON.stringify(manifest.pinned ?? []);
  const today = dayKey(nowMs);
  const starsById = {};
  for (const item of manifest.items) starsById[item.id] = statsById[item.id]?.stars ?? item.stars;
  const nextHistory = updateStarsHistory(history, starsById, today);
  const withDelta = {};
  for (const item of manifest.items) {
    withDelta[item.id] = { ...(statsById[item.id] ?? {}), stars_7d_delta: computeDelta(nextHistory, item.id, starsById[item.id], today) };
  }
  const { items, changed } = applyStats(manifest.items, withDelta);
  const changedAny = pinsChanged || changed;
  const historyChanged = JSON.stringify(nextHistory) !== JSON.stringify(history);
  return {
    changed: changedAny || historyChanged,
    manifestChanged: changedAny,
    history: nextHistory,
    manifest: changedAny ? { ...manifest, generated_at: isoNow(nowMs), pinned, items } : manifest,
  };
}

/** 单次别名 GraphQL 查询一批 GitHub 仓库及其讨论（变量绑定，不拼接用户输入）。 */
export function buildBatchQuery(batch) {
  const vars = {};
  const defs = [];
  const fields = batch.map((item, i) => {
    vars[`o${i}`] = item.owner;
    vars[`r${i}`] = item.repo;
    defs.push(`$o${i}: String!`, `$r${i}: String!`);
    let part = `r${i}: repository(owner: $o${i}, name: $r${i}) { stargazerCount forkCount latestRelease { tagName } }`;
    if (item.discussion_repo && item.discussion_number) {
      const [dOwner, dName] = item.discussion_repo.split('/');
      vars[`do${i}`] = dOwner;
      vars[`dn${i}`] = dName;
      vars[`d${i}n`] = item.discussion_number;
      defs.push(`$do${i}: String!`, `$dn${i}: String!`, `$d${i}n: Int!`);
      part += ` d${i}: repository(owner: $do${i}, name: $dn${i}) { discussion(number: $d${i}n) { upvoteCount comments { totalCount } } }`;
    }
    return part;
  });
  return { query: `query(${defs.join(', ')}) { ${fields.join(' ')} }`, variables: vars };
}

export async function fetchGithubStats(items, { token, fetchImpl }) {
  const out = {};
  for (let i = 0; i < items.length; i += GRAPHQL_BATCH) {
    const batch = items.slice(i, i + GRAPHQL_BATCH);
    const { query, variables } = buildBatchQuery(batch);
    const data = await graphql(query, variables, { token, fetchImpl });
    batch.forEach((item, j) => {
      const repo = data?.[`r${j}`];
      const disc = data?.[`d${j}`]?.discussion;
      if (!repo) return;
      out[item.id] = {
        stars: repo.stargazerCount,
        forks: repo.forkCount,
        latest_version: repo.latestRelease?.tagName ?? undefined,
        discussion_comments_count: disc?.comments?.totalCount,
        discussion_upvotes: disc?.upvoteCount,
      };
    });
  }
  return out;
}

async function fetchOtherForgeStats(item, { fetchImpl }) {
  if (item.forge === 'gitlab') {
    const enc = encodeURIComponent(`${item.owner}/${item.repo}`);
    const repo = await rest(`https://${item.forge_host}/api/v4/projects/${enc}`, { fetchImpl, allow404: true });
    return repo ? { stars: repo.star_count, forks: repo.forks_count } : null;
  }
  const base = `https://${item.forge_host}/api/v1/repos/${item.owner}/${item.repo}`;
  const repo = await rest(base, { fetchImpl, allow404: true });
  if (!repo) return null;
  const release = await rest(`${base}/releases/latest`, { fetchImpl, allow404: true });
  return { stars: repo.stars_count, forks: repo.forks_count, latest_version: release?.tag_name };
}

export async function collectStats(items, { token, fetchImpl = fetch }) {
  const github = items.filter((it) => it.forge === 'github');
  const stats = await fetchGithubStats(github, { token, fetchImpl });
  for (const item of items.filter((it) => it.forge !== 'github')) {
    try {
      const s = await fetchOtherForgeStats(item, { fetchImpl });
      if (s) stats[item.id] = s;
    } catch {
      // 单个托管源失败不阻断其余条目
    }
  }
  return stats;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifestFile = path.join(rootDir, 'launchpad.json');
  const historyFile = path.join(rootDir, 'state', 'stars-history.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : { version: 1, days: {} };
  const stats = await collectStats(manifest.items, { token: process.env.GITHUB_TOKEN });
  const result = refreshManifest(manifest, history, stats, Date.now());
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.writeFileSync(historyFile, formatJson(result.history));
  if (result.manifestChanged) {
    const errors = validateLaunchpad(result.manifest);
    if (errors.length) throw new Error(`刷新后的清单未通过校验：\n${errors.join('\n')}`);
    fs.writeFileSync(manifestFile, formatJson(result.manifest));
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
  console.log(result.changed ? '✓ launchpad.json 已更新' : '✓ 无实质变化');
}
