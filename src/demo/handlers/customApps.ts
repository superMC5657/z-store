// 只引类型：services/custom 的运行时依赖 services/api，提前求值会抢在 mock 安装前判定 isTauri。
import type { DraftEntryWire, DraftItemWire, DraftStatus } from '../../services/custom';
import { LS, lsGet, lsSet } from '../demoState';
import { argStr, nowSecs, warnUnknownArgs, type InvokeArgs } from './common';
import backendConfigToml from '../../../src-tauri/config.toml?raw';

/**
 * 「待收录」草稿域 mock（`custom_apps` 表，ADR-0017）：读写 `LS.customApps`（种子见 seed.ts）。
 * 状态流转门禁、列表排序、Issue 预填链接与 payload 形态均对齐
 * `src-tauri/src/commands/catalog_custom.rs` 与 `db/custom_apps.rs`；
 * 字段级提交档校验由前端 `draftModel` 在调用前完成，这里不重复。
 */

/** 与后端 `CATALOG_REPO_ISSUES_URL` 同值。 */
const CATALOG_REPO_ISSUES_NEW_URL = 'https://github.com/superMC5657/z-store-catalog/issues/new';

/** 与 `services/custom.isCollectedStatus` 同口径（`local_collected` 为存储同义值）。 */
function isCollectedStatus(status: string): boolean {
  return status === 'collected' || status === 'local_collected';
}

let entries: DraftEntryWire[] | null = null;

function load(): DraftEntryWire[] {
  if (!entries) {
    const stored = lsGet<unknown>(LS.customApps, []);
    entries = Array.isArray(stored) ? (stored as DraftEntryWire[]) : [];
  }
  return entries;
}

function persist(): void {
  if (entries) lsSet(LS.customApps, entries);
}

function find(id: string): DraftEntryWire {
  const key = id.trim().toLowerCase();
  const hit = load().find((e) => e.id.toLowerCase() === key);
  if (!hit) throw new Error(`草稿不存在: ${key}`);
  return hit;
}

function snapshot(e: DraftEntryWire): DraftEntryWire {
  return { ...e, item: { ...e.item } };
}

function setStatus(e: DraftEntryWire, status: DraftStatus, prUrl: string | null): DraftEntryWire {
  e.status = status;
  e.pr_url = prUrl;
  e.updated_at = nowSecs();
  persist();
  return snapshot(e);
}

export function handleListCustomApps(a: InvokeArgs): DraftEntryWire[] {
  warnUnknownArgs(['includeArchived'], a, 'handleListCustomApps');
  const includeArchived = a['includeArchived'] === true;
  return load()
    .filter((e) => includeArchived || !e.archived)
    .sort((x, y) => y.updated_at - x.updated_at)
    .map(snapshot);
}

/** 新建行 `status=draft`；已存在行只刷新 payload（`status` / `pr_url` 保持），`is_verified` 恒为 false。 */
export function handleSaveCustomApp(a: InvokeArgs): DraftEntryWire {
  warnUnknownArgs(['item'], a, 'handleSaveCustomApp');
  const item = a['item'] as DraftItemWire | undefined;
  if (!item || typeof item.id !== 'string' || !item.id) throw new Error('demo: invalid custom app payload');
  const key = item.id.toLowerCase();
  const list = load();
  const existing = list.find((e) => e.id.toLowerCase() === key);
  const t = nowSecs();
  if (existing) {
    existing.item = { ...item, id: key, is_verified: false };
    existing.updated_at = t;
    persist();
    return snapshot(existing);
  }
  const created: DraftEntryWire = {
    id: key,
    item: { ...item, id: key, is_verified: false },
    status: 'draft',
    pr_url: null,
    created_at: t,
    updated_at: t,
    archived: false,
  };
  list.push(created);
  persist();
  return snapshot(created);
}

export function handleDeleteCustomApp(a: InvokeArgs): boolean {
  warnUnknownArgs(['id'], a, 'handleDeleteCustomApp');
  const key = argStr(a, 'id').toLowerCase();
  const list = load();
  const idx = list.findIndex((e) => e.id.toLowerCase() === key);
  if (idx < 0) return false;
  list.splice(idx, 1);
  persist();
  return true;
}

export function handleCollectLocalApp(a: InvokeArgs): DraftEntryWire {
  warnUnknownArgs(['id'], a, 'handleCollectLocalApp');
  const e = find(argStr(a, 'id'));
  if (e.archived) throw new Error(`草稿已转正归档，无需重复收录: ${e.id}`);
  if (e.status === 'submitted') throw new Error(`已提交行不可重复收录: ${e.id}`);
  return setStatus(e, 'collected', e.pr_url ?? null);
}

export function handleRevertCollectedApp(a: InvokeArgs): DraftEntryWire {
  warnUnknownArgs(['id'], a, 'handleRevertCollectedApp');
  const e = find(argStr(a, 'id'));
  if (e.archived) throw new Error(`草稿已转正归档，不可退回草稿: ${e.id}`);
  if (e.status === 'submitted') throw new Error(`已提交行不可退回草稿: ${e.id}`);
  if (!isCollectedStatus(e.status)) throw new Error(`仅已收录行可退回草稿: ${e.id}`);
  return setStatus(e, 'draft', null);
}

export function handleWithdrawSubmitted(a: InvokeArgs): DraftEntryWire {
  warnUnknownArgs(['id'], a, 'handleWithdrawSubmitted');
  const e = find(argStr(a, 'id'));
  if (e.archived) throw new Error(`已转正归档行不可标记为未提交: ${e.id}`);
  if (e.status !== 'submitted') throw new Error(`仅已提交行可标记为未提交: ${e.id}`);
  return setStatus(e, 'collected', null);
}

/** 与后端 `ensure_collected_for_pr` 同口径：仅已收录行可走 Issue 链路。 */
function ensureCollectedForPr(e: DraftEntryWire): void {
  if (e.status === 'submitted') throw new Error(`已提交行不可重复提交: ${e.id}`);
  if (!isCollectedStatus(e.status)) throw new Error('须先收录进本地再提交 Issue');
}

export function handleMarkCustomSubmitted(a: InvokeArgs): DraftEntryWire {
  warnUnknownArgs(['id', 'prUrl'], a, 'handleMarkCustomSubmitted');
  const prUrl = argStr(a, 'prUrl').trim();
  if (!prUrl) throw new Error('提交链接 pr_url 不可为空');
  if (!prUrl.startsWith('https://')) throw new Error('提交链接 pr_url 必须为 https 链接');
  const e = find(argStr(a, 'id'));
  if (e.archived) throw new Error(`草稿已转正归档，无需重复提交: ${e.id}`);
  ensureCollectedForPr(e);
  return setStatus(e, 'submitted', prUrl);
}

// -- Issue 预填（对齐 `normalize_pr_item` + `pr_single_payload_json`）-----------

const IDENTIFIER_KEY_RANK: Record<string, number> = { windows: 0, linux: 1, macos: 2, android: 3, ios: 4 };

function inlineStrArray(arr: readonly string[]): string {
  return `[${arr.map((s) => JSON.stringify(s)).join(', ')}]`;
}

function nonBlank(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.trim() !== '';
}

/**
 * 单条 Issue payload：模板风格 2 空格缩进、字符串数组单行内联、空值字段省略；
 * 丢弃 install_dirs / search_subdirs / publishers / added_at，`is_verified` 预置 true
 *（仅预填副本，存储仍为 false）。
 */
function prPayloadJson(item: DraftItemWire): string {
  const fields: string[] = [];
  const put = (key: string, rendered: string): void => {
    fields.push(`  ${JSON.stringify(key)}: ${rendered}`);
  };
  put('id', JSON.stringify(item.id));
  put('name', JSON.stringify(item.name));
  put('owner', JSON.stringify(item.owner));
  put('repo', JSON.stringify(item.repo));
  if (nonBlank(item.icon)) put('icon', JSON.stringify(item.icon));
  if (nonBlank(item.icon_bg)) put('icon_bg', JSON.stringify(item.icon_bg));
  if (nonBlank(item.description)) put('description', JSON.stringify(item.description));
  if (nonBlank(item.description_en)) put('description_en', JSON.stringify(item.description_en));
  put('category', JSON.stringify(item.category));
  put('category_name', JSON.stringify(item.category_name));
  if (item.aliases.length > 0) put('aliases', inlineStrArray(item.aliases));
  put('default_version', JSON.stringify(item.default_version));
  put('license', JSON.stringify(item.license));
  if (item.stars !== 0) put('stars', String(item.stars));
  if (item.forks !== 0) put('forks', String(item.forks));
  put('is_verified', 'true');
  if (nonBlank(item.homepage)) put('homepage', JSON.stringify(item.homepage));
  if (item.platforms.length > 0) put('platforms', inlineStrArray(item.platforms));
  const idKeys = Object.keys(item.identifiers)
    .filter((k) => item.identifiers[k].length > 0)
    .sort((x, y) => (IDENTIFIER_KEY_RANK[x] ?? 99) - (IDENTIFIER_KEY_RANK[y] ?? 99) || x.localeCompare(y));
  if (idKeys.length > 0) {
    const rows = idKeys.map(
      (k, i) => `    ${JSON.stringify(k)}: ${inlineStrArray(item.identifiers[k])}${i + 1 < idKeys.length ? ',' : ''}`,
    );
    put('identifiers', `{\n${rows.join('\n')}\n  }`);
  }
  return `{\n${fields.join(',\n')}\n}`;
}

function prIssueUrl(e: DraftEntryWire): string {
  const item = e.item;
  const title = `[收录申请] ${e.id}`;
  const body = [
    '## 收录申请（本地自维护草稿预填）',
    '',
    `- 应用：${item.name} (\`${e.id}\`)`,
    `- 仓库：${item.owner}/${item.repo}`,
    `- 主页：${(item.homepage ?? '').trim()}`,
    `- 协议：${item.license}`,
    `- 分类：${item.category}（${item.category_name}）`,
    `- 版本：${item.default_version}`,
    `- 状态：${e.status}`,
    '',
    '本地校验：已通过提交档 `validate_custom_item(strict)`（canonical id / 必填字段 / OSI 协议），payload 见下方 JSON。',
    '',
    '### payload_json',
    '',
    '```json',
    prPayloadJson(item),
    '```',
    '',
  ].join('\n');
  return `${CATALOG_REPO_ISSUES_NEW_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export function handleGetCustomAppPrUrl(a: InvokeArgs): string {
  warnUnknownArgs(['id'], a, 'handleGetCustomAppPrUrl');
  const e = find(argStr(a, 'id'));
  ensureCollectedForPr(e);
  return prIssueUrl(e);
}

export function handleGetCustomAppPrPayload(a: InvokeArgs): string {
  warnUnknownArgs(['id'], a, 'handleGetCustomAppPrPayload');
  const e = find(argStr(a, 'id'));
  ensureCollectedForPr(e);
  return prPayloadJson(e.item);
}

/**
 * 许可名单（ADR-0018）：直接解析后端同一份 `config.toml` 的 `[license_gate]` 段，
 * 不在前端另维护名单（`statefulHandlers.test.ts` 锁定能解析出非空名单）。
 */
export function parseLicenseGate(toml: string): { enabled: boolean; allowed: string[] } {
  const section = /^\[license_gate\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? '';
  const enabled = !/^\s*enabled\s*=\s*false\b/m.test(section);
  const list = /^\s*allowed\s*=\s*\[([^\]]*)\]/m.exec(section)?.[1] ?? '';
  const allowed = [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((v) => v.trim() !== '');
  return { enabled, allowed };
}

const LICENSE_GATE = parseLicenseGate(backendConfigToml);

export function handleGetLicenseAllowlist(): { enabled: boolean; allowed: string[] } {
  return { enabled: LICENSE_GATE.enabled, allowed: [...LICENSE_GATE.allowed] };
}

/** 测试用：丢弃内存缓存，下次读取重新从 localStorage 载入。 */
export function resetCustomAppsCache(): void {
  entries = null;
}
