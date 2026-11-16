#!/usr/bin/env node
/**
 * publish-launch.mjs
 *
 * 维护者打标即上架（approved / pinned-7d / pinned-14d / pinned-30d / featured-7d）：
 *   prepare  —— 校验操作人权限 → 二次体检 → 置顶坑位保护 → 复用或创建 Discussion →
 *               幂等写入 launchpad.json，并把结果写到 --result 文件；
 *   announce —— 推送成功后回复传播物料包（深链 / 讨论 / README 徽章），关闭 Issue 并打 published。
 *
 * git 提交与推送由工作流在两个阶段之间完成（同一 launchpad-json-write 并发组串行）。
 *
 * 环境变量：REPO, ISSUE_NUMBER, ISSUE_BODY, LABEL, SENDER, GITHUB_TOKEN
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHPAD_REPO,
  SPOTLIGHT_MAX_SLOTS,
  addDaysIso,
  formatJson,
  isoNow,
  sortItems,
} from './lib/shared.mjs';
import { addLabels, graphql, hasWritePermission, removeLabel, rest, upsertMarkedComment } from './lib/github.mjs';
import { parseLinkedDiscussion, verifySubmission } from './verify-submission.mjs';
import { validateLaunchpad } from './validate-launchpad.mjs';

export const PUBLISH_MARKER = '<!-- zstore-launchpad-bot-published -->';
export const PUBLISH_LABELS = ['approved', 'pinned-7d', 'pinned-14d', 'pinned-30d', 'featured-7d'];

/** 标签 → 置顶参数；`approved` 返回 `null`（只进普通新品池）。 */
export function labelToPin(label) {
  const m = /^(pinned|featured)-(\d+)d$/.exec(label);
  if (!m) return null;
  return { tier: m[1] === 'featured' ? 'featured' : 'sponsor', days: Number(m[2]) };
}

/** 移除已过期置顶并按原顺序重排 `pin_order = 1..k`（条目本体保留在 items）。 */
export function dropExpiredPins(pinned, nowMs) {
  return pinned
    .filter((p) => Date.parse(p.pin_until) > nowMs)
    .sort((a, b) => a.pin_order - b.pin_order || a.id.localeCompare(b.id))
    .map((p, i) => ({ ...p, pin_order: i + 1 }));
}

/**
 * 幂等写入上架条目（纯函数）：
 * - 同 id 二次上架刷新版本、自荐语等元数据，保留首发时间与讨论绑定；
 * - 置顶标签：先清过期坑位；其余有效置顶（不含同 id 续期）已满 4 个时整体拒绝并给出最早释放时间。
 * 返回 `{ status: 'ok', manifest, item, pin }` 或 `{ status: 'slots_full', earliestRelease }`。
 */
export function applyLaunch(manifest, incoming, { label, nowMs }) {
  const pinSpec = labelToPin(label);
  const pinned = dropExpiredPins(manifest.pinned ?? [], nowMs);
  const others = pinned.filter((p) => p.id !== incoming.id);
  if (pinSpec && others.length >= SPOTLIGHT_MAX_SLOTS) {
    const earliestRelease = others.map((p) => p.pin_until).sort()[0];
    return { status: 'slots_full', earliestRelease };
  }

  const existing = (manifest.items ?? []).find((it) => it.id === incoming.id);
  const item = existing
    ? {
        ...existing,
        ...incoming,
        launched_at: existing.launched_at,
        stars_7d_delta: existing.stars_7d_delta,
        discussion_repo: incoming.discussion_repo ?? existing.discussion_repo,
        discussion_number: incoming.discussion_number ?? existing.discussion_number,
        discussion_node_id: incoming.discussion_node_id ?? existing.discussion_node_id,
        discussion_url: incoming.discussion_url ?? existing.discussion_url,
        discussion_comments_count: existing.discussion_comments_count,
        discussion_upvotes: existing.discussion_upvotes,
      }
    : { discussion_comments_count: 0, discussion_upvotes: 0, ...incoming };
  if (!item.discussion_node_id) delete item.discussion_node_id;
  const items = sortItems([...(manifest.items ?? []).filter((it) => it.id !== incoming.id), item]);

  let nextPinned = pinned;
  let pin = null;
  if (pinSpec) {
    const current = pinned.find((p) => p.id === incoming.id);
    pin = {
      id: incoming.id,
      pin_until: addDaysIso(nowMs, pinSpec.days),
      pin_tier: pinSpec.tier,
      pin_order: current ? current.pin_order : others.length + 1,
    };
    nextPinned = [...others, pin].sort((a, b) => a.pin_order - b.pin_order);
  }
  return {
    status: 'ok',
    item,
    pin,
    manifest: { ...manifest, generated_at: isoNow(nowMs), pinned: nextPinned, items },
  };
}

const CATEGORY_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    discussionCategories(first: 20) { nodes { id name slug } }
  }
}`;

const CREATE_DISCUSSION = `
mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
    discussion { id number url }
  }
}`;

const DISCUSSION_LOOKUP = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { discussion(number: $number) { id number url } }
}`;

export function discussionTitle(item) {
  return `${item.name} (${item.owner}/${item.repo}) — ${item.maker_note}`.slice(0, 250);
}

export function discussionBody(item) {
  return [
    `**${item.name}** · ${item.description}`,
    '',
    `> ${item.maker_note}`,
    '',
    `- 支持平台 / Platforms: ${item.platforms.join(', ')}`,
    `- 协议 / License: ${item.license}`,
    `- 源仓库 / Repository: https://${item.forge_host}/${item.owner}/${item.repo}`,
    `- 在 ZStore 中打开 / Open in ZStore: \`zstore://launchpad/${item.id}\``,
    '',
    '欢迎 +1 顶帖并留下你的使用反馈！ / Upvote and share your feedback!',
  ].join('\n');
}

/** 复用或创建 Discussion：作者关联帖 → 存量绑定 → 在 Launches 分类新建。 */
export async function resolveDiscussion({ item, submission, existing, token, fetchImpl }) {
  const linked = parseLinkedDiscussion(submission.linked_discussion_url);
  if (linked) {
    const [owner, name] = linked.repo.split('/');
    const data = await graphql(DISCUSSION_LOOKUP, { owner, name, number: linked.number }, { token, fetchImpl });
    const d = data?.repository?.discussion;
    if (d) return { discussion_repo: linked.repo, discussion_number: d.number, discussion_node_id: d.id, discussion_url: d.url };
  }
  if (existing?.discussion_number) {
    return {
      discussion_repo: existing.discussion_repo,
      discussion_number: existing.discussion_number,
      discussion_node_id: existing.discussion_node_id,
      discussion_url: existing.discussion_url,
    };
  }
  const [owner, name] = LAUNCHPAD_REPO.split('/');
  const repoData = await graphql(CATEGORY_QUERY, { owner, name }, { token, fetchImpl });
  const category = repoData?.repository?.discussionCategories?.nodes?.find(
    (c) => c.slug === 'launches' || c.name.toLowerCase() === 'launches',
  );
  if (!category) throw new Error('未找到 Launches 讨论分类，请先运行 scripts/bootstrap-repo.sh 并在 Settings 中创建');
  const created = await graphql(
    CREATE_DISCUSSION,
    { repositoryId: repoData.repository.id, categoryId: category.id, title: discussionTitle(item), body: discussionBody(item) },
    { token, fetchImpl },
  );
  const d = created.createDiscussion.discussion;
  return { discussion_repo: LAUNCHPAD_REPO, discussion_number: d.number, discussion_node_id: d.id, discussion_url: d.url };
}

/** 作者传播物料包。 */
export function renderShareKit(item, pin) {
  const badge = `[![Launched on ZStore](https://img.shields.io/badge/ZStore-Launchpad-111111?style=flat-square)](https://z-store.org/launchpad)`;
  return [
    '### 🚀 已上架开源广场 / Launched on ZStore Launchpad',
    '',
    pin ? `置顶推荐至 ${pin.pin_until}（${pin.pin_tier}） / Spotlight until ${pin.pin_until}` : '已加入「最新上架」新品池 / Listed in Recent Launches',
    '',
    `- 广场直达 / Launchpad link: \`zstore://launchpad/${item.id}\``,
    `- 应用详情 / App detail: \`zstore://app/${item.id}\``,
    `- 社区讨论 / Discussion: ${item.discussion_url}`,
    '',
    'README 徽章 / README badge:',
    '',
    '```markdown',
    badge,
    '```',
  ].join('\n');
}

async function prepare({ rootDir, resultFile, env, fetchImpl }) {
  const { REPO: repo, ISSUE_NUMBER: issue, LABEL: label, SENDER: sender, GITHUB_TOKEN: token } = env;
  const write = (result) => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  if (!PUBLISH_LABELS.includes(label)) return write({ status: 'skipped', reason: `label ${label}` });
  if (!(await hasWritePermission({ repo, user: sender, token, fetchImpl }))) {
    return write({ status: 'skipped', reason: 'sender lacks write permission' });
  }
  const verified = await verifySubmission(env.ISSUE_BODY ?? '', { token, fetchImpl });
  if (!verified.ok) {
    await upsertMarkedComment({
      repo, issue, marker: PUBLISH_MARKER, token, fetchImpl,
      body: ['### ❌ 上架前复检未通过 / Re-check failed', '', ...verified.errors.map((e) => `- ${e}`)].join('\n'),
    });
    await removeLabel({ repo, issue, label, token, fetchImpl });
    await addLabels({ repo, issue, labels: ['needs-changes'], token, fetchImpl });
    return write({ status: 'rejected' });
  }
  const file = path.join(rootDir, 'launchpad.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nowMs = Date.now();
  const probe = applyLaunch(manifest, { ...verified.item }, { label, nowMs });
  if (probe.status === 'slots_full') {
    await upsertMarkedComment({
      repo, issue, marker: PUBLISH_MARKER, token, fetchImpl,
      body: [
        '### ⏳ 置顶坑位已满 / Spotlight slots are full',
        '',
        `当前 ${SPOTLIGHT_MAX_SLOTS} 个置顶坑位均在有效期内，最早释放时间：**${probe.earliestRelease}**。`,
        '请排队后重新打置顶标签，或改打 `approved` 先进入「最新上架」新品池。',
      ].join('\n'),
    });
    await removeLabel({ repo, issue, label, token, fetchImpl });
    return write({ status: 'slots_full', earliestRelease: probe.earliestRelease });
  }
  const existing = manifest.items.find((it) => it.id === verified.item.id);
  const discussion = await resolveDiscussion({ item: verified.item, submission: verified.submission, existing, token, fetchImpl });
  const result = applyLaunch(manifest, { ...verified.item, ...discussion }, { label, nowMs });
  const errors = validateLaunchpad(result.manifest);
  if (errors.length) throw new Error(`写入后的清单未通过校验：\n${errors.join('\n')}`);
  fs.writeFileSync(file, formatJson(result.manifest));
  return write({ status: 'ok', item: result.item, pin: result.pin });
}

async function announce({ resultFile, env, fetchImpl }) {
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (result.status !== 'ok') return;
  const { REPO: repo, ISSUE_NUMBER: issue, GITHUB_TOKEN: token } = env;
  await upsertMarkedComment({ repo, issue, marker: PUBLISH_MARKER, body: renderShareKit(result.item, result.pin), token, fetchImpl });
  await addLabels({ repo, issue, labels: ['published'], token, fetchImpl });
  await rest(`/repos/${repo}/issues/${issue}`, {
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'completed' },
    token,
    fetchImpl,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const phase = args[0];
  const resultFile = args.includes('--result') ? args[args.indexOf('--result') + 1] : 'publish-result.json';
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ctx = { rootDir, resultFile, env: process.env, fetchImpl: fetch };
  if (phase === 'prepare') await prepare(ctx);
  else if (phase === 'announce') await announce(ctx);
  else {
    console.error('用法: node scripts/publish-launch.mjs <prepare|announce> [--result file]');
    process.exit(2);
  }
}
