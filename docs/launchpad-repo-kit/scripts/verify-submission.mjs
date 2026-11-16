#!/usr/bin/env node
/**
 * verify-submission.mjs
 *
 * 投稿体检：解析 submit-launchpad.yml 渲染出的 Issue 正文 → 本地字段校验 → 请求托管源公开 API
 * （公开、非归档、非 Fork、OSI 协议、最新 Release 至少 1 个安装包）→ 生成卡片预览。
 *
 * Issue 正文只当数据：经环境变量 ISSUE_BODY 传入，绝不拼进 shell。
 *
 * 用法（Actions）：
 *   ISSUE_BODY=... REPO=owner/repo ISSUE_NUMBER=12 GITHUB_TOKEN=... node scripts/verify-submission.mjs --post
 * 本地预演：
 *   node scripts/verify-submission.mjs --body-file issue.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  CATEGORY_KEYS,
  FORGE_HOSTS,
  MAKER_NOTE_MAX,
  charCount,
  deriveId,
  foldLine,
  isOsiLicense,
  optionKey,
  parseIssueForm,
  parseRepoUrl,
  platformsFromAssets,
} from './lib/shared.mjs';
import { addLabels, removeLabel, rest, upsertMarkedComment } from './lib/github.mjs';

export const PREVIEW_MARKER = '<!-- zstore-launchpad-bot-preview -->';

/** Issue Form 字段 id → 渲染标题（与 .github/ISSUE_TEMPLATE/submit-launchpad.yml 的 label 一致）。 */
export const FORM_HEADINGS = {
  repo_url: '开源仓库地址 / Repository URL',
  app_name: '应用名称 / App name',
  category: '功能分类 / Category',
  maker_note: '一句话自荐 / Maker note',
  maker_note_en: '英文自荐语 / Maker note (English)',
  launch_tier: '上架档位 / Launch tier',
  sponsor_order_ref: '赞助凭证尾号 / Sponsor order reference',
  custom_icon_url: '自定义图标 / Custom icon URL',
  homepage: '项目主页 / Homepage',
  linked_discussion_url: '关联 Discussion / Linked discussion URL',
  floss_confirm: '开源承诺 / FLOSS confirmation',
};

export const LAUNCH_TIERS = ['free', 'spotlight-7d', 'spotlight-14d', 'spotlight-30d'];

/** 解析投稿正文为结构化字段（自荐语折叠为单行）。 */
export function parseSubmission(body) {
  const raw = parseIssueForm(body, FORM_HEADINGS);
  return {
    repo_url: foldLine(raw.repo_url),
    app_name: foldLine(raw.app_name),
    category: optionKey(raw.category),
    maker_note: foldLine(raw.maker_note),
    maker_note_en: foldLine(raw.maker_note_en),
    launch_tier: optionKey(raw.launch_tier),
    sponsor_order_ref: foldLine(raw.sponsor_order_ref),
    custom_icon_url: foldLine(raw.custom_icon_url),
    homepage: foldLine(raw.homepage),
    linked_discussion_url: foldLine(raw.linked_discussion_url),
    floss_confirmed: /^- \[x\]/im.test(raw.floss_confirm),
  };
}

const LINKED_DISCUSSION = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/discussions\/(\d+)\/?$/;

export function parseLinkedDiscussion(url) {
  const m = LINKED_DISCUSSION.exec(String(url || '').trim());
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

/** 不访问网络的字段校验，返回错误列表。 */
export function checkSubmissionFields(sub) {
  const errors = [];
  if (!parseRepoUrl(sub.repo_url)) errors.push('仓库地址无法识别：需为 GitHub / Codeberg / Gitea / GitLab 的 https 公开仓库地址');
  if (!sub.app_name) errors.push('应用名称不能为空');
  else if (charCount(sub.app_name) > 60) errors.push('应用名称不能超过 60 个字符');
  if (!CATEGORY_KEYS.includes(sub.category)) errors.push('请选择标准功能分类');
  const n = charCount(sub.maker_note);
  if (n < 1 || n > MAKER_NOTE_MAX) errors.push(`一句话自荐需为 1~${MAKER_NOTE_MAX} 字（当前 ${n} 字）`);
  if (sub.maker_note_en && charCount(sub.maker_note_en) > MAKER_NOTE_MAX * 2) errors.push('英文自荐语过长');
  if (!LAUNCH_TIERS.includes(sub.launch_tier)) errors.push('请选择上架档位');
  if (sub.custom_icon_url && !/^https:\/\/\S+$/.test(sub.custom_icon_url)) errors.push('自定义图标仅接受 https:// 直链');
  if (sub.homepage && !/^https?:\/\/\S+$/.test(sub.homepage)) errors.push('项目主页需为 http(s) 地址');
  if (sub.linked_discussion_url && !parseLinkedDiscussion(sub.linked_discussion_url)) {
    errors.push('关联 Discussion 需为 https://github.com/owner/repo/discussions/<编号>');
  }
  if (sub.sponsor_order_ref && !/^[A-Za-z0-9-]{1,40}$/.test(sub.sponsor_order_ref)) {
    errors.push('赞助凭证仅填写订单号或交易号尾号（字母数字，40 字符内）');
  }
  if (!sub.floss_confirmed) errors.push('请勾选开源承诺');
  return errors;
}

function forgeApiBase(coord) {
  if (coord.forge === 'github') return 'https://api.github.com';
  if (coord.forge === 'gitlab') return `https://${coord.forge_host}/api/v4`;
  return `https://${coord.forge_host}/api/v1`;
}

/** 请求托管源公开 API，归一为 `RepoFacts`。 */
export async function fetchRepoFacts(coord, { token, fetchImpl = fetch } = {}) {
  const base = forgeApiBase(coord);
  const ghToken = coord.forge === 'github' ? token : undefined;
  if (coord.forge === 'gitlab') {
    const enc = encodeURIComponent(`${coord.owner}/${coord.repo}`);
    const repo = await rest(`${base}/projects/${enc}?license=true`, { fetchImpl, allow404: true });
    if (!repo) return null;
    const release = await rest(`${base}/projects/${enc}/releases/permalink/latest`, { fetchImpl, allow404: true });
    return {
      private: repo.visibility !== 'public',
      archived: Boolean(repo.archived),
      fork: Boolean(repo.forked_from_project),
      license: repo.license?.key ? String(repo.license.key).toUpperCase() : '',
      stars: repo.star_count ?? 0,
      forks: repo.forks_count ?? 0,
      description: repo.description ?? '',
      homepage: '',
      owner_avatar: repo.namespace?.avatar_url ?? repo.avatar_url ?? '',
      owner_html: repo.namespace?.web_url ?? `https://${coord.forge_host}/${coord.owner}`,
      latest_version: release?.tag_name ?? '',
      latest_release_at: release?.released_at ?? release?.created_at ?? '',
      assets: (release?.assets?.links ?? []).map((l) => l.name),
    };
  }
  const repo = await rest(`${base}/repos/${coord.owner}/${coord.repo}`, { token: ghToken, fetchImpl, allow404: true });
  if (!repo) return null;
  const release = await rest(`${base}/repos/${coord.owner}/${coord.repo}/releases/latest`, {
    token: ghToken,
    fetchImpl,
    allow404: true,
  });
  const license =
    coord.forge === 'github'
      ? repo.license?.spdx_id ?? ''
      : Array.isArray(repo.licenses) && repo.licenses.length
        ? repo.licenses[0]
        : '';
  return {
    private: Boolean(repo.private),
    archived: Boolean(repo.archived),
    fork: Boolean(repo.fork),
    license: String(license),
    stars: repo.stargazers_count ?? repo.stars_count ?? 0,
    forks: repo.forks_count ?? 0,
    description: repo.description ?? '',
    homepage: repo.homepage ?? repo.website ?? '',
    owner_avatar: repo.owner?.avatar_url ?? '',
    owner_html: repo.owner?.html_url ?? `https://${coord.forge_host}/${coord.owner}`,
    latest_version: release?.tag_name ?? '',
    latest_release_at: release?.published_at ?? release?.created_at ?? '',
    assets: (release?.assets ?? []).map((a) => a.name),
  };
}

/** 体检仓库事实，返回 `{ errors, platforms }`。 */
export function evaluateRepo(facts) {
  const errors = [];
  if (!facts) return { errors: ['仓库不存在或不可公开访问'], platforms: [] };
  if (facts.private) errors.push('仓库不是公开仓库');
  if (facts.archived) errors.push('仓库已归档（Archived）');
  if (facts.fork) errors.push('仓库为 Fork：请提交上游仓库或在独立仓库发行');
  if (!facts.license || facts.license === 'NOASSERTION') errors.push('未检测到开源协议（NOASSERTION）');
  else if (!isOsiLicense(facts.license)) errors.push(`协议 ${facts.license} 不在 ZStore OSI 白名单内`);
  const platforms = platformsFromAssets(facts.assets);
  if (!facts.latest_version) errors.push('未找到最新 Release');
  else if (platforms.length === 0) errors.push('最新 Release 中没有可识别的安装包构建资产');
  return { errors, platforms };
}

/** 由投稿与仓库事实组装清单条目（不含讨论绑定字段）。 */
export function buildItem(sub, coord, facts, platforms, nowIso) {
  const category = CATEGORIES.find((c) => c.key === sub.category);
  const license = facts.license;
  const item = {
    id: deriveId(coord),
    name: sub.app_name,
    owner: coord.owner,
    repo: coord.repo,
    forge: coord.forge,
    forge_host: coord.forge_host,
    icon: sub.custom_icon_url || '',
    icon_bg: '',
    description: facts.description?.trim() || sub.maker_note,
    maker_note: sub.maker_note,
    maker: {
      login: coord.owner,
      avatar_url: facts.owner_avatar || `https://${coord.forge_host}/${coord.owner}.png`,
      html_url: facts.owner_html || `https://${coord.forge_host}/${coord.owner}`,
    },
    category: sub.category,
    category_name: category?.name ?? sub.category,
    license,
    latest_version: facts.latest_version,
    platforms,
    stars: facts.stars,
    stars_7d_delta: 0,
    forks: facts.forks,
    launched_at: nowIso,
  };
  if (sub.maker_note_en) item.maker_note_en = sub.maker_note_en;
  if (facts.latest_release_at) item.latest_release_at = facts.latest_release_at;
  const homepage = sub.homepage || facts.homepage;
  if (homepage && /^https?:\/\//.test(homepage)) item.homepage = homepage;
  return item;
}

/** 完整体检（字段 + 远端），返回 `{ ok, errors, item, coord, submission }`。 */
export async function verifySubmission(body, { token, fetchImpl, nowIso = new Date().toISOString() } = {}) {
  const submission = parseSubmission(body);
  const errors = checkSubmissionFields(submission);
  const coord = parseRepoUrl(submission.repo_url);
  if (!coord) return { ok: false, errors, item: null, coord: null, submission };
  if (!(coord.forge in FORGE_HOSTS)) errors.push('不支持的托管源');
  let facts = null;
  try {
    facts = await fetchRepoFacts(coord, { token, fetchImpl });
  } catch (e) {
    errors.push(`查询托管源失败：${e.message}`);
  }
  const evaluated = evaluateRepo(facts);
  if (facts || !errors.some((e) => e.startsWith('查询托管源失败'))) errors.push(...evaluated.errors);
  const item = facts ? buildItem(submission, coord, facts, evaluated.platforms, nowIso.replace(/\.\d{3}Z$/, 'Z')) : null;
  return { ok: errors.length === 0, errors, item, coord, submission };
}

/** Markdown 体检报告（不回显赞助凭证，避免二次扩散）。 */
export function renderReport(result) {
  const lines = [];
  if (result.ok) {
    lines.push('### ✅ 自动体检通过 / Automated checks passed', '', '维护者审核后打上准入标签即可自动上架。');
  } else {
    lines.push('### ❌ 需要修改 / Changes needed', '');
    for (const e of result.errors) lines.push(`- ${e}`);
  }
  if (result.item) {
    const it = result.item;
    lines.push(
      '',
      '| 项目 | 内容 |',
      '| --- | --- |',
      `| 应用 | ${escapeCell(it.name)} (\`${it.id}\`) |`,
      `| 协议 | ${escapeCell(it.license || '—')} |`,
      `| 版本 | ${escapeCell(it.latest_version || '—')} |`,
      `| 平台 | ${it.platforms.join(', ') || '—'} |`,
      `| 档位 | ${result.submission.launch_tier} |`,
      `| 自荐语 | ${escapeCell(it.maker_note)} |`,
      '',
      '<details><summary>卡片预览 JSON</summary>',
      '',
      '```json',
      JSON.stringify(it, null, 2),
      '```',
      '</details>',
    );
  }
  return lines.join('\n');
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const bodyFile = args.includes('--body-file') ? args[args.indexOf('--body-file') + 1] : null;
  const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : process.env.ISSUE_BODY ?? '';
  const token = process.env.GITHUB_TOKEN;
  const result = await verifySubmission(body, { token });
  const report = renderReport(result);
  if (args.includes('--post')) {
    const repo = process.env.REPO;
    const issue = process.env.ISSUE_NUMBER;
    await upsertMarkedComment({ repo, issue, marker: PREVIEW_MARKER, body: report, token });
    if (result.ok) {
      await addLabels({ repo, issue, labels: ['validated'], token });
      await removeLabel({ repo, issue, label: 'needs-changes', token });
    } else {
      await addLabels({ repo, issue, labels: ['needs-changes'], token });
      await removeLabel({ repo, issue, label: 'validated', token });
    }
  } else {
    console.log(report);
  }
  if (args.includes('--strict') && !result.ok) process.exit(1);
}
