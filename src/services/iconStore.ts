/** 前端图标深 module（deep module，`IconFetch` 前端收口）。
 * module：`services/iconStore` 为图标写唯一深 module；`AppIcon`/`Search List Cache`/
 * `trends/enrich`/`trends/board` 不自立图标 locality，并行 mem-cache 均内聚为本 module 内部 seam。
 * interface：唯一对外写 interface 为 `admitIconHit`（`icon-ready` 统一收口）+ 读侧扇出
 * `subscribeIconWrites`（读侧只合并、不调写口，不复活窗口总线）；读口 `getBufferedIcon`/
 * `getCachedIconDataUri` 为展示/组装用只读 interface；`stickyIconFor`/`patchIconMirror`/
 * `patchAppIconList` 为组装/镜像用的纯合并 interface（内部 seam 的收敛实现，调用方直引、不自立规则）。
 * depth：`admitIconHit` 内聚 generation gate（`search_id`/`board`+`gen`）+ L-monotone（纯L 1..5，
 * 低不顶高，`via` 正交）+ `via`（`live|m2`，`data:` 只进 M1 内存；m2+http 远端落盘自愈）+ L5 badge
 *（`icon:'' + level:5` 唯一允许的空覆盖，经 fan-out）+ fan-out（`notifyIconWrites`）。
 * 一次 `IconFetch` 命中经 `icon-ready` 只跳本 module 单 interface。
 * seam：`admitIconHit` 为唯一写 seam；`stickyIconFor`（`mergeStickyIcon` + M1 缓冲回读）与
 * `patchIconMirror`（趋势镜像合并）与 `iconDataCache`（`get_or_fetch_icon` 落盘预热内存态）均为内部 seam，
 * 对外不新增写口。
 * adapter/leverage/locality：`App.tsx` 经 `patchAppIconList` + `subscribeIconWrites` 内联四连直写；
 * `isRemoteIcon` 留在
 * `AppIcon`（展示判定，与店内 `isRemoteHttpIconUrl` 落盘门控正交，非重复）。
 * 领域词：`IconFetch`（后端 `fetch_icons_stream`）→ `icon-ready`（`zstore://icon-ready`）→
 * 本 module `admitIconHit`；`Search List Cache`（`searchListCache.ts` 纯前端内存）经 `getBufferedIcon` 回读，
 * 不另立图标规则。`boardReady`/`swrSyncedResult`/`isUpgradePending` 仍为趋势视图内部态，不进本 module。
 * 合规：level 纯L + `via` 正交 + M1/M2 划分遵 ADR-0015；`normalizeId` 归一遵 ADR-0010；
 * 展示图标分层（品牌母版/桌面外壳/运行时矢量）遵 ADR-0005，本 module 只碰运行时列表图标 URL，不碰品牌资产。
 * L5 显式徽章（用户切空，`icon:'' + level:5`）为唯一允许的空覆盖：经 `admitIconHit`
 * 清记忆 + `patch('')` + 读侧扇出；被动空壳（无 level 5）仍直接丢弃。
 * 读侧扇出（`subscribeIconWrites`）：`admitIconHit` 受理后通知订阅者（App 四列表/趋势镜像），
 * 写口仍唯一，不复活窗口总线。`clearBufferedIcon` 亦经同一扇出（直接清零亦通知，防富卡 stale；
 * `applyBadgeHit` 内走批量单事件，直接调用走单键事件）。
 */
import type { AppSummary } from '../types';
import { normalizeId, normalizeIdSet } from './normalizeId';
import { tauriInvoke } from './api/client';

/** 空图标判定 SSOT（读透适配统一用此件，不各自 `trim()===''` 散写）。 */
export function isEmptyIcon(icon: unknown): boolean {
  return typeof icon !== 'string' || icon.trim() === '';
}

/** 纯L合法性：1..5 为合法 level（1官方/2品牌库/3仓库/4 README/5空徽章）；
 * 其余视为缺省（放行但不推进记忆）。L5 为显式空（cycle 切空），参与单调
 * （L2→L5 接受、L5→L2 判 stale，见 `HomeView.search-icon` 回归线）。 */
export function isPureLevel(level: unknown): level is number {
  return (
    typeof level === 'number' &&
    Number.isFinite(level) &&
    Number.isInteger(level) &&
    level >= 1 &&
    level <= 5
  );
}

/** 图标事件上下文（后端 `icon_fetch::IconFetchCtx` 的前端镜像）。 */
export interface IconHitContext {
  kind: 'search' | 'trend' | string;
  search_id?: string;
  board?: string;
  gen?: number;
}

/** 图标命中（`id` 应用标识 + `icon/level/via/context`）。 */
export interface IconHit {
  /** 应用标识（小写 `owner/repo`；坐标键与 id 键同值，店内按归一键扇出）。 */
  id?: string | null;
  icon?: string | null;
  /** `level`纯L（2=L2品牌库，3=L3仓库；单调记忆，via正交）。 */
  level?: number | null;
  /** 缓存正交：`live|m2`（M2首屏直填不走emit）。 */
  via?: string | null;
  context?: IconHitContext | null;
}

/** 事件载荷（`zstore://icon-ready`，供 `catalog.ts` 订阅打型）。 */
export interface IconReadyPayload {
  id: string;
  icon: string;
  level: number;
  /** 缓存正交：`live|m2`（M2首屏直填不走emit）。 */
  via?: string;
  context: IconHitContext;
}

export interface AdmitIconHitArgs extends IconHit {
  /**
   * Search 世代门控期望值：当前搜索 id（字符串或取值函数）。
   * 双非空且与命中 `search_id` 不等即丢弃；任一为空即放行。
   */
  currentSearchId?: string | (() => string | undefined) | null;
  getCurrentSearchId?: () => string | undefined;
  /**
   * Trend 世代门控期望值：榜单 id / 榜单世代 / 取榜单世代函数。
   * `board` 双非空不等即丢弃，任一为空即放行；`gen` 仅双方均为数字时比对。
   */
  board?: string | null;
  boardGen?: number | null;
  getBoardGen?: ((board?: string) => number | undefined) | null;
  /** React 四列表写透钩（App 注入 `setApps/setOnlineApps/...`）。缺省则只做缓存层。 */
  patch?: ((targetIdLower: string, icon: string) => void) | null;
  /** 已有实图查询（`''` 守卫用，缺省回退店内记忆）。 */
  getCurrentIcon?: ((targetIdLower: string) => string | undefined) | null;
}

export interface AdmitIconHitResult {
  accepted: boolean;
  targets?: string[];
  icon?: string;
  level?: number;
  /** `true`=已入队 `queueIconFetches→get_or_fetch_icon`；`false`=M1纯内存（`data:`/非远端 m2）。 */
  queued?: boolean;
  reason?: string;
}

/**
 * 单图标升级时仅替换对应 id 的对象，其余复用原引用；
 * 若目标不存在或图标已一致则直接返回原数组引用，避免全网格重渲染闪烁。
 *（唯一实现处：调用方经 `services/iconStore` 直引。）
 */
export function patchAppIconList(
  prev: AppSummary[],
  targetIdLower: string,
  icon: string,
): AppSummary[] {
  let changed = false;
  const next = prev.map((a) => {
    if (normalizeId(a.id) === targetIdLower) {
      if (a.icon === icon) return a;
      changed = true;
      return { ...a, icon };
    }
    return a;
  });
  return changed ? next : prev;
}

/**
 * 读侧扇出订阅：`admitIconHit` 受理写入后通知订阅者（App 四列表写透/趋势镜像跟进）。
 * 写口仍唯一是 `admitIconHit`；订阅回调只做读侧合并，不得再调 `admitIconHit`（防递归）。
 * 窗口总线不复活：订阅表常驻店内模块，卸载即退订。
 */
export interface IconWriteEvent {
  targets: string[];
  icon: string;
  level?: number;
}
export type IconWriteSubscriber = (hit: IconWriteEvent) => void;
const iconWriteSubscribers = new Set<IconWriteSubscriber>();

export function subscribeIconWrites(fn: IconWriteSubscriber): () => void {
  iconWriteSubscribers.add(fn);
  return () => {
    iconWriteSubscribers.delete(fn);
  };
}

function notifyIconWrites(targets: string[], icon: string, level?: number): void {
  if (iconWriteSubscribers.size === 0) return;
  for (const fn of [...iconWriteSubscribers]) {
    try {
      fn({ targets, icon, level });
    } catch {
      // 单订阅失败不阻塞其余订阅
    }
  }
}

/** 仅供测试：清空读侧订阅（防跨文件泄漏）。 */
export function __resetIconWriteSubscribersForTests(): void {
  iconWriteSubscribers.clear();
}

/**
 * 归一 id 目标集：取 `id` 去空 → 归一去重保序。
 */
export function resolveIconTargets(hit: Pick<IconHit, 'id'>): string[] {
  return normalizeIdSet([hit?.id]);
}

/** 仅 `http(s)` 才算可落盘远端（`data:` 另行内存通道，其余一律丢弃）。 */
export function isRemoteHttpIconUrl(icon: unknown): boolean {
  if (typeof icon !== 'string') return false;
  const u = icon.trim().toLowerCase();
  return u.startsWith('http://') || u.startsWith('https://');
}

/**
 * icon 粘性 supersede-only 合并（内部 seam 的收敛实现）：
 * 旧图标非空 + 回填图标空 → 沿用旧图标；其余一律采用回填值。
 * 空值经 `isEmptyIcon` SSOT，不自立 `trim()===''` 规则。
 */
export function mergeStickyIcon(
  cur: AppSummary | undefined,
  incoming: AppSummary,
): AppSummary {
  const curIcon = cur && typeof cur.icon === 'string' ? cur.icon : '';
  const incomingIcon = typeof incoming.icon === 'string' ? incoming.icon : '';
  if (cur && !isEmptyIcon(curIcon) && isEmptyIcon(incomingIcon)) {
    return { ...incoming, icon: cur.icon };
  }
  return incoming;
}

/**
 * icon 粘性 + M1 缓冲回读（内部 seam 的收敛实现）：
 * 先 `mergeStickyIcon`（旧实 + 回填空 → 沿用旧），再空壳经 `getBufferedIcon` 唯一口
 * 回读缓冲实图（坐标键 + id 键双查，`normalizeId` 归一，遵 ADR-0010）。
 * 调用方（`enrich.put`/`assembleOnlineRowsWithIcons`）直引此 interface，不自立空值/缓冲规则；
 * `Search List Cache` 命中行组装亦经此口，空壳不覆盖缓冲实图。
 */
export function stickyIconFor(cur: AppSummary | undefined, incoming: AppSummary): AppSummary {
  const merged = mergeStickyIcon(cur, incoming);
  if (!isEmptyIcon(merged.icon)) return merged;
  const coordKey =
    incoming.owner && incoming.repo
      ? `${normalizeId(incoming.owner)}/${normalizeId(incoming.repo)}`
      : '';
  const idKey = typeof incoming.id === 'string' ? normalizeId(incoming.id) : '';
  const buffered =
    (coordKey ? getBufferedIcon(coordKey) : undefined) ??
    (idKey ? getBufferedIcon(idKey) : undefined);
  if (buffered && !isEmptyIcon(buffered)) {
    return { ...merged, icon: buffered };
  }
  return merged;
}

/**
 * 趋势镜像图标合并（内部 seam 的收敛实现）：
 * incoming 与旧不同即覆盖；L5（`''`）放行内存清零；大小写归一，同时匹配坐标键与
 * `enriched.id` 小写别名（`normalizeId`，遵 ADR-0010）。调用方直调本函数。
 */
export function patchIconMirror(
  prev: Record<string, AppSummary>,
  appIdNorm: string,
  rawIcon: string,
): Record<string, AppSummary> {
  if (!appIdNorm) return prev;
  const norm = normalizeId(appIdNorm);
  if (!norm) return prev;
  let changed = false;
  const next = { ...prev };
  for (const k of Object.keys(prev)) {
    const cur = prev[k];
    const alias = normalizeId((cur as AppSummary | undefined)?.id);
    if (normalizeId(k) === norm || (alias !== '' && alias === norm)) {
      if (cur.icon !== rawIcon) {
        next[k] = { ...cur, icon: rawIcon };
        changed = true;
      }
    }
  }
  return changed ? next : prev;
}

/** `level`纯L单调记忆（别名共享最大值，低不顶高，via正交）+ 图标M1内存缓冲已有实图记忆（`''` 守卫回退）。 */
const iconLevelById = new Map<string, number>();
const iconById = new Map<string, string>();

/**
 * 图标展示数据内存态（本 module 内部 seam）：
 * `get_or_fetch_icon` 落盘后的 `data:` 直显态，`key` 为远端 URL 或归一 id（小写）。
 * 别名源唯一是店内 `iconById`（`normalizeId`）。
 */
const iconDataCache = new Map<string, string>();
const iconPendingPromises = new Map<string, Promise<string>>();
/** 入队成功标记（入队成功即 `queued=true`，`data:`/非远端 m2 永不置位）。URL 与 id 别名同置。 */
const iconPersistedKeys = new Set<string>();
/** 同 tick 合并队列：`url → ids`（`queueIconFetches` 只入队，排空时按 URL 单次下载）。 */
const iconPreloadQueue = new Map<string, Set<string>>();
/** 在途别名扇出：`url → ids`（同 URL 共用 Promise，成功时一并写 `iconDataCache`）。 */
const iconPendingAliases = new Map<string, Set<string>>();
/** 失败退避：`url → 可重试时间戳`（失败即 `delete` pending + 退避 30s，期内跳过）。 */
const iconPreloadBackoffUntil = new Map<string, number>();
let iconPreloadScheduled = false;
const ICON_PRELOAD_BACKOFF_MS = 30_000; // stale-while-revalidate guard for batch preload: failures back off 30s while the UI keeps showing the stale URL.

function resolveCurrentSearchId(args: AdmitIconHitArgs): string {
  try {
    if (typeof args.getCurrentSearchId === 'function') {
      const v = args.getCurrentSearchId();
      if (typeof v === 'string' && v) return v;
    }
  } catch {
    // 取值失败按空处理（放行）
  }
  const c = args.currentSearchId;
  try {
    if (typeof c === 'function') {
      const v = (c as () => string | undefined)();
      return typeof v === 'string' ? v : '';
    }
  } catch {
    return '';
  }
  return typeof c === 'string' ? c : '';
}

function hasExistingRealIcon(targets: string[], getCurrentIcon?: AdmitIconHitArgs['getCurrentIcon']): boolean {
  for (const t of targets) {
    const tracked = iconById.get(t);
    if (typeof tracked === 'string' && tracked.trim() !== '') return true;
    if (typeof getCurrentIcon === 'function') {
      try {
        const cur = getCurrentIcon(t);
        if (typeof cur === 'string' && cur.trim() !== '') return true;
      } catch {
        // 查询失败即按无实图处理
      }
    }
  }
  return false;
}

/**
 * 世代门控快照：`search_id`（搜索）/`board`+`gen`（榜单）三段。
 * 双非空不等即过期，任一为空即放行。
 */
export interface GenerationGate {
  search_id?: string | null;
  board?: string | null;
  gen?: number | null;
}

/**
 * 展示数据失效（内部 seam）：
 * 删 `iconDataCache`/`pending`/`队列`/`queued` 中该键及其关联 URL/别名态。以店内 `iconById` 为唯一别名源
 * （`normalizeId`，遵 ADR-0010）。
 */
export function invalidateIconCache(key?: string): void {
  if (!key) {
    iconDataCache.clear();
    iconPendingPromises.clear();
    iconPendingAliases.clear();
    iconPreloadQueue.clear();
    iconPersistedKeys.clear();
    iconPreloadScheduled = false;
    return;
  }
  const norm = normalizeId(key);
  const candidates = new Set<string>([key, norm]);
  // id→URL 别名经店内 `iconById` 单源回查（无并行 map）。
  const mappedUrl = norm ? iconById.get(norm) : undefined;
  if (typeof mappedUrl === 'string' && mappedUrl) {
    candidates.add(mappedUrl);
    candidates.add(normalizeId(mappedUrl));
  }
  // URL→id 反查：同 URL 的别名 data 态一并失效。
  if (norm) {
    for (const [id, url] of iconById.entries()) {
      if (normalizeId(url) === norm || url === key) {
        candidates.add(id);
        candidates.add(normalizeId(id));
      }
    }
  }
  for (const c of candidates) {
    if (!c) continue;
    iconDataCache.delete(c);
    iconPendingPromises.delete(c);
    iconPendingAliases.delete(c);
    iconPreloadQueue.delete(c);
    iconPersistedKeys.delete(c);
  }
}

/**
 * 展示数据读口（内部 seam，`AppIcon` 展示经此唯一口读 `data:` 直显态）：
 * 命中即直显（`preload` 落盘后的内存态），否则回落 prop 直显；空 prop 恒徽章。
 */
export function getCachedIconDataUri(key: string): string | undefined {
  if (typeof key !== 'string' || key === '') return undefined;
  return iconDataCache.get(key) ?? (normalizeId(key) ? iconDataCache.get(normalizeId(key)) : undefined);
}

/**
 * 远端预热（内部 seam）：
 * 队列 + 单飞 + 批量排空：同 tick 多次调用合并为 `Set<url>`，同 URL 共用 Promise；
 * 仅远端（`http(s)`/`data:` 兼容展示判定由调用方保证，此处复用店内落盘门控）走
 * `get_or_fetch_icon` 落盘；`data:`/空永不预热；退避期内跳过。
 * `data:` 纯内存路径不经此（`admitIconHit` 内跳过）。
 * 成功置 `queued=true` + 写 `iconDataCache`（URL + id 别名扇出）；
 * 失败 `delete` pending + 退避 30s（展示回落 URL 直显，不抛错、不产生未处理拒绝）。
 * 非 Tauri（单测/jsdom/浏览器预览）只收队不清耗（展示回落 URL 直显，不抛错）。
 */
export function queueIconFetches(items: (string | { id?: string; icon: string })[]): void {
  if (!items || items.length === 0) return;
  for (const item of items) {
    const icon = typeof item === 'string' ? item : item.icon;
    const id = typeof item === 'string' ? undefined : item.id;
    if (typeof icon !== 'string' || icon === '') continue;
    if (icon.startsWith('data:')) continue;
    if (!isRemoteHttpIconUrl(icon) && !icon.includes('.png') && !icon.includes('.svg') && !icon.includes('.jpg') && !icon.includes('.webp') && !icon.includes('.ico')) continue;
    // 已落盘：直接扇出 id 别名（同 URL 多别名一次即全），不重复入队。
    const cached = iconDataCache.get(icon);
    if (typeof cached === 'string' && cached !== '') {
      if (typeof id === 'string' && id !== '') {
        if (!iconDataCache.has(id)) iconDataCache.set(id, cached);
        const nid = normalizeId(id);
        if (nid && !iconDataCache.has(nid)) iconDataCache.set(nid, cached);
        iconPersistedKeys.add(icon);
        iconPersistedKeys.add(id);
        if (nid) iconPersistedKeys.add(nid);
      }
      continue;
    }
    // 退避期内跳过（失败退避，不雪崩）。
    const backoffUntil = iconPreloadBackoffUntil.get(icon);
    if (typeof backoffUntil === 'number' && backoffUntil > Date.now()) continue;
    // 在途单飞：同 URL 共用 Promise，仅合并别名扇出表。
    if (iconPendingPromises.has(icon)) {
      if (typeof id === 'string' && id !== '') {
        let aliases = iconPendingAliases.get(icon);
        if (!aliases) {
          aliases = new Set<string>();
          iconPendingAliases.set(icon, aliases);
        }
        aliases.add(id);
        const nid = normalizeId(id);
        if (nid) aliases.add(nid);
      }
      continue;
    }
    // 同 tick 合并：同 URL 合并 `Set<url>`，ids 并集合并。
    let queued = iconPreloadQueue.get(icon);
    if (!queued) {
      queued = new Set<string>();
      iconPreloadQueue.set(icon, queued);
    }
    if (typeof id === 'string' && id !== '') {
      queued.add(id);
      const nid = normalizeId(id);
      if (nid) queued.add(nid);
    }
  }
  schedulePreloadDrain();
}

/**
 * 列表组装落盘补齐上限：与首屏预热同量级（30），防 N+1 风暴。
 */
export const ASSEMBLED_ROW_ICON_QUEUE_CAP = 30;

/**
 * 同步覆盖查询：URL 已落盘（`iconDataCache` 有非空 `data:`）或已在队/在途
 * （`iconPreloadQueue`/`iconPendingPromises`）即算已覆盖，选批时跳过不占名额。
 * 失败退避中不算已覆盖（允许重试，仍占名额）。`data:`/空永不算覆盖（调用方另行跳过）。
 */
export function isIconPersistedOrQueued(url: unknown): boolean {
  if (typeof url !== 'string' || url === '') return false;
  const cached = iconDataCache.get(url);
  if (typeof cached === 'string' && cached !== '') return true;
  const nid = normalizeId(url);
  if (nid && nid !== url) {
    const cachedNorm = iconDataCache.get(nid);
    if (typeof cachedNorm === 'string' && cachedNorm !== '') return true;
  }
  if (iconPendingPromises.has(url)) return true;
  if (iconPreloadQueue.has(url)) return true;
  if (nid && nid !== url) {
    if (iconPendingPromises.has(nid)) return true;
    if (iconPreloadQueue.has(nid)) return true;
  }
  return false;
}

/**
 * 列表组装落盘补齐：对行中 http 远端图标调一次 `queueIconFetches`。
 * 同 tick 合并 + 单飞 + 30s 退避 + 已落盘/在途去重皆复用 `queueIconFetches` 内部机制；
 * 本函数选批时先跳过已覆盖（已落盘/在队/在途，经 `isIconPersistedOrQueued`，
 * 退避中不算覆盖允许重试），再计 30 上限，让位给 30 名开外的新行。
 * `data:`/空跳过；同批内重复 URL 去重不占名额。
 */
export function queueAssembledRowIcons(
  rows: readonly { id?: string; icon?: unknown }[] | undefined,
): void {
  if (!rows || rows.length === 0) return;
  const batch: { id?: string; icon: string }[] = [];
  const seenInBatch = new Set<string>();
  for (const row of rows) {
    if (batch.length >= ASSEMBLED_ROW_ICON_QUEUE_CAP) break;
    const icon = typeof row?.icon === 'string' ? row.icon : '';
    if (!isRemoteHttpIconUrl(icon)) continue;
    if (isIconPersistedOrQueued(icon)) continue;
    const batchKey = normalizeId(icon) || icon;
    if (seenInBatch.has(batchKey)) continue;
    seenInBatch.add(batchKey);
    seenInBatch.add(icon);
    const id = typeof row?.id === 'string' ? row.id : undefined;
    batch.push(id === undefined ? { icon } : { id, icon });
  }
  if (batch.length > 0) queueIconFetches(batch);
}

/**
 * 首屏前 30 预热：取前 30 入队，后续经 `queueIconFetches` 合并排空。
 */
export function preloadTop30Icons(items: readonly (string | { id?: string; icon: string })[]): void {
  if (!items || items.length === 0) return;
  queueIconFetches(items.slice(0, 30) as (string | { id?: string; icon: string })[]);
}

function isTauriAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return '__TAURI_INTERNALS__' in window;
  } catch {
    return false;
  }
}

function schedulePreloadDrain(): void {
  if (iconPreloadScheduled) return;
  if (iconPreloadQueue.size === 0) return;
  iconPreloadScheduled = true;
  const run = (): void => {
    drainIconPreloadQueue();
  };
  try {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(run);
      return;
    }
  } catch {
    // 回落定时器
  }
  setTimeout(run, 0);
}

/** 批量排空：快照队列后逐 URL 单次 `get_or_fetch_icon`（单飞由 `pending` 保证）。 */
function drainIconPreloadQueue(): void {
  iconPreloadScheduled = false;
  if (iconPreloadQueue.size === 0) return;
  if (!isTauriAvailable()) {
    // 非 Tauri 只收队（单测/jsdom 不产生 IPC/拒绝，展示回落 URL 直显）。
    iconPreloadQueue.clear();
    return;
  }
  const batch = [...iconPreloadQueue.entries()];
  iconPreloadQueue.clear();
  for (const [url, ids] of batch) {
    if (!url) continue;
    if (iconDataCache.has(url)) {
      // 并发已落盘：仅扇出别名。
      const cached = iconDataCache.get(url);
      if (typeof cached === 'string' && cached !== '') {
        for (const id of ids) {
          if (id && !iconDataCache.has(id)) iconDataCache.set(id, cached);
          iconPersistedKeys.add(url);
          if (id) iconPersistedKeys.add(id);
        }
      }
      continue;
    }
    if (iconPendingPromises.has(url)) {
      // 并发已在途：合并别名后共用 Promise。
      let aliases = iconPendingAliases.get(url);
      if (!aliases) {
        aliases = new Set<string>();
        iconPendingAliases.set(url, aliases);
      }
      for (const id of ids) if (id) aliases.add(id);
      continue;
    }
    const backoffUntil = iconPreloadBackoffUntil.get(url);
    if (typeof backoffUntil === 'number' && backoffUntil > Date.now()) continue;
    startIconFetch(url, ids);
  }
}

function startIconFetch(url: string, ids: Set<string>): void {
  const aliasSet = new Set<string>(ids);
  iconPendingAliases.set(url, aliasSet);
  // 多别名同 URL 取首个非空 id 透传后端（其余经成功扇出写缓存）。
  let firstId: string | null = null;
  for (const id of aliasSet) {
    if (id) {
      firstId = id;
      break;
    }
  }
  const p = tauriInvoke<string>('get_or_fetch_icon', { appId: firstId, remoteUrl: url })
    .then((dataUri) => {
      iconDataCache.set(url, dataUri);
      iconPersistedKeys.add(url);
      const aliases = iconPendingAliases.get(url) ?? aliasSet;
      for (const id of aliases) {
        if (!id) continue;
        iconDataCache.set(id, dataUri);
        iconPersistedKeys.add(id);
        const nid = normalizeId(id);
        if (nid) {
          iconDataCache.set(nid, dataUri);
          iconPersistedKeys.add(nid);
        }
      }
      iconPendingPromises.delete(url);
      iconPendingAliases.delete(url);
      iconPreloadBackoffUntil.delete(url);
      return dataUri;
    })
    .catch(() => {
      // 预热失败静默吞掉（展示回落 URL 直显，不产生未处理拒绝；退避后可后台重预热）。
      iconPendingPromises.delete(url);
      iconPendingAliases.delete(url);
      iconPreloadBackoffUntil.set(url, Date.now() + ICON_PRELOAD_BACKOFF_MS);
      return '';
    });
  iconPendingPromises.set(url, p);
  // 挂载空 catch 防未处理拒绝（上已吞错，此处再兜底一次）。
  void p.catch(() => undefined);
}

/** 仅供测试：同步排空队列并等待在途（首见 http 即单次下载断言用）。 */
export function __flushIconPreloadsForTests(): Promise<void> {
  drainIconPreloadQueue();
  if (iconPendingPromises.size === 0) return Promise.resolve();
  return Promise.allSettled([...iconPendingPromises.values()]).then(() => undefined);
}

/** 仅供测试：队列 + 在途总数（同 tick 合并断言用）。 */
export function __getIconPreloadQueueSizeForTests(): number {
  return iconPreloadQueue.size + iconPendingPromises.size;
}

/** 仅供测试：读退避状态。 */
export function __getIconPreloadBackoffForTests(url: string): number | undefined {
  return iconPreloadBackoffUntil.get(url);
}

/** 仅供测试：模拟落盘写 `iconDataCache`（`queueAssembledRowIcons` 让位断言用）。 */
export function __setIconDataCacheForTests(key: string, dataUri: string): void {
  if (typeof key !== 'string' || key === '') return;
  if (typeof dataUri !== 'string' || dataUri === '') return;
  iconDataCache.set(key, dataUri);
}

/** 仅供测试：清空展示数据内存态（防跨文件泄漏）。 */
export function __resetIconDataCacheForTests(): void {
  iconDataCache.clear();
  iconPendingPromises.clear();
  iconPendingAliases.clear();
  iconPreloadQueue.clear();
  iconPersistedKeys.clear();
  iconPreloadBackoffUntil.clear();
  iconPreloadScheduled = false;
}

/**
 * 唯一写入口：`icon-ready` 统一收口（M1内存唯一口，经 `getBufferedIcon` 回读）。
 * `level`纯L单调；`data:` 只进 M1 内存；m2+http 远端走落盘路自愈（m2 不推进 `level` 记忆）；
 * M2首屏直填不走emit。
 * L5 显式徽章（`icon:'' + level:5`，用户切空意图）为唯一允许的空覆盖：
 * 清图标+level 记忆（cycle-back 可重接受 L2..L4）+ `invalidate` + `patch('')` + 读侧扇出；
 * 其余空图标一律丢弃（被动空壳保护）。
 * 时机：`invalidateIconCache` 先失效 → `queueIconFetches` → `patch` 写透四列表 → 读侧扇出。
 */
/**
 * L5 显式徽章写（`admitIconHit` 内唯一空覆盖分支）：清图标+level 记忆
 * （`deleteBufferedIcon` 同语义，cycle-back 可重接受 L2..L4，不复活旧图）、
 * `invalidate` 展示数据、`patch('')` 写透、读侧扇出。无网络副作用。
 */
function applyBadgeHit(
  targets: string[],
  patch?: AdmitIconHitArgs['patch'],
): AdmitIconHitResult {
  for (const t of targets) {
    try {
      invalidateIconCache(t);
    } catch {
      // 缓存失效失败不阻塞内存写透
    }
    deleteBufferedIcon(t);
  }
  if (typeof patch === 'function') {
    for (const t of targets) {
      try {
        patch(t, '');
      } catch {
        // 单别名 patch 失败不阻塞其余别名
      }
    }
  }
  notifyIconWrites(targets, '', 5);
  return { accepted: true, targets, icon: '', level: 5, queued: false, reason: 'level5-badge' };
}

export function admitIconHit(args: AdmitIconHitArgs): AdmitIconHitResult {
  if (!args || typeof args !== 'object') return { accepted: false, reason: 'empty-hit' };

  const targets = resolveIconTargets(args);
  if (targets.length === 0) return { accepted: false, reason: 'missing-target' };

  const rawIcon = typeof args.icon === 'string' ? args.icon.trim() : '';
  // L5 显式徽章优先：用户切空意图（`icon:'' + level:5`）走唯一写口扇出，
  // 不受被动空壳守卫拦截；其余空图标永不覆盖已有实图，直接丢弃。
  if (rawIcon === '' && typeof args.level === 'number' && args.level === 5) {
    return applyBadgeHit(targets, args.patch);
  }
  // `''` 永不覆盖已有实图；无实图时亦为无操作，直接丢弃。
  if (rawIcon === '') {
    const keep = hasExistingRealIcon(targets, args.getCurrentIcon);
    return { accepted: false, targets, reason: keep ? 'empty-keeps-real' : 'empty-noop' };
  }
  const icon = rawIcon;

  // 世代门控：过期判断只此一处，正交三维（`search_id`/`board`/`gen` 各自双非空不等即过期，任一为空即放行，不看 `kind`）。
  // incoming 取 `context`，expected 即时取值回落静态值。
  const ctx = args.context ?? null;
  const incoming: GenerationGate = {
    search_id:
      ctx && typeof ctx.search_id === 'string' && ctx.search_id
        ? ctx.search_id
        : '',
    board: ctx && typeof ctx.board === 'string' ? ctx.board : '',
    gen: ctx && typeof ctx.gen === 'number' && Number.isFinite(ctx.gen) ? ctx.gen : undefined,
  };
  const incomingBoard = typeof incoming.board === 'string' ? incoming.board : '';
  let expectedGen: number | undefined;
  try {
    if (typeof args.getBoardGen === 'function') {
      const key = normalizeId(args.board) || normalizeId(incomingBoard) || undefined;
      const v = args.getBoardGen(key);
      if (typeof v === 'number' && Number.isFinite(v)) expectedGen = v;
    }
  } catch {
    // 取值失败按空处理（放行）
  }
  if (
    expectedGen === undefined &&
    typeof args.boardGen === 'number' &&
    Number.isFinite(args.boardGen)
  ) {
    expectedGen = args.boardGen;
  }
  const expected: GenerationGate = {
    search_id: resolveCurrentSearchId(args),
    board: typeof args.board === 'string' ? args.board : '',
    gen: expectedGen,
  };
  let stale: string | undefined;
  {
    const a = typeof incoming.search_id === 'string' ? incoming.search_id : '';
    const b = typeof expected.search_id === 'string' ? expected.search_id : '';
    if (a && b && a !== b) stale = 'stale-search-id';
  }
  if (!stale) {
    const ib = normalizeId(incoming.board);
    const eb = normalizeId(expected.board);
    if (ib && eb && ib !== eb) stale = 'stale-board';
  }
  if (!stale) {
    if (
      incoming.gen !== undefined &&
      expected.gen !== undefined &&
      incoming.gen !== expected.gen
    ) {
      stale = 'stale-board-gen';
    }
  }
  if (stale) return { accepted: false, targets, icon, reason: stale };

  // `level`纯L单调：低不顶高，via正交不参与比较。缺省即放行且不推进记忆。
  // 仅 1..5 合法（`isPureLevel`）；`data:` 只进 M1 内存，m2 不推进 `level` 记忆（只做 stale 判定，不写）。
  const level =
    typeof args.level === 'number' && Number.isFinite(args.level) ? args.level : undefined;
  const pureLevel = isPureLevel(level) ? (level as number) : undefined;
  const via = typeof args.via === 'string' ? args.via.trim().toLowerCase() : '';
  // `isMemoryOnly` 拆分：`data:` 保持纯内存；`via=m2` 仅非远端走内存——m2 携带 http
  // 远端（无文件回退 `selected_url`）时走 live 同落盘路自愈，后端 LRU“只删文件不删 URL”靠此回填。
  const isMemoryOnly = icon.startsWith('data:') || (via === 'm2' && !isRemoteHttpIconUrl(icon));
  let nextLevel: number | undefined;
  if (pureLevel !== undefined) {
    let currentMax: number | undefined;
    for (const t of targets) {
      const s = iconLevelById.get(t);
      if (s !== undefined && (currentMax === undefined || s > currentMax)) currentMax = s;
    }
    if (currentMax !== undefined && pureLevel < currentMax) {
      return { accepted: false, targets, icon, level: pureLevel, reason: 'level-stale' };
    }
    nextLevel = currentMax === undefined ? pureLevel : Math.max(currentMax, pureLevel);
    // `data:`/`m2` 不推进：此处只算出 `nextLevel`，落盘路径才写记忆。
  }

  // `data:`/非远端 m2 只进 M1 内存：失效 + patch 内存态，跳过 `queueIconFetches`，
  // 不推进 `level` 记忆；m2+http 远端下沉到远端分支落盘。
  if (isMemoryOnly) {
    for (const t of targets) {
      try {
        invalidateIconCache(t);
      } catch {
        // 缓存失效失败不阻塞内存写透
      }
      iconById.set(t, icon);
    }
    const patch = args.patch;
    if (typeof patch === 'function') {
      for (const t of targets) {
        try {
          patch(t, icon);
        } catch {
          // 单别名 patch 失败不阻塞其余别名
        }
      }
    }
    notifyIconWrites(targets, icon, pureLevel);
    return {
      accepted: true,
      targets,
      icon,
      level: pureLevel,
      queued: false,
      reason: icon.startsWith('data:') ? 'data-memory-only' : 'm2-memory-only',
    };
  }

  // 仅 `remote(http)` 才 `patch state + queueIconFetches` 走 `get_or_fetch_icon` 落盘（含 m2 回退远端）。
  // 批量收集一次 `preload`（同 URL 多别名一次入队），`patch` 仍逐个别名内存写透。
  if (!isRemoteHttpIconUrl(icon)) {
    return { accepted: false, targets, icon, level: pureLevel, reason: 'non-remote-dropped' };
  }
  // 落盘路径推进 `level` 记忆；m2 不推进（首屏直填不挡后续 live 升级，单调门控语义不变）。
  if (nextLevel !== undefined && via !== 'm2') {
    for (const t of targets) iconLevelById.set(t, nextLevel);
  }
  for (const t of targets) {
    try {
      invalidateIconCache(t);
    } catch {
      // 同上
    }
  }
  try {
    queueIconFetches(targets.map((t) => ({ id: t, icon })));
  } catch {
    // 预热失败不阻塞列表写透（AppIcon 侧按 URL 直显兜底）
  }
  const patch = args.patch;
  if (typeof patch === 'function') {
    for (const t of targets) {
      try {
        patch(t, icon);
      } catch {
        // 同上
      }
    }
  }
  for (const t of targets) iconById.set(t, icon);
  notifyIconWrites(targets, icon, pureLevel);
  return { accepted: true, targets, icon, level: pureLevel, queued: true };
}

/** 仅供测试：清空 `level`/图标记忆（含展示数据态）。 */
export function __resetIconStoreForTests(): void {
  iconLevelById.clear();
  iconById.clear();
  iconDataCache.clear();
  iconPendingPromises.clear();
  iconPendingAliases.clear();
  iconPreloadQueue.clear();
  iconPersistedKeys.clear();
  iconPreloadBackoffUntil.clear();
  iconPreloadScheduled = false;
}

/**
 * M1内存缓冲读口（经 `iconById`，`admitIconHit`唯一写口）：`icon-ready` 先到、
 * `enrich` 后到竞态时，`enrich` 组装经此取缓冲实图，空壳不覆盖缓冲实图。
 * `data:` 只走此内存态；m2+http 兼走落盘路（内存写透照常）；M2首屏直填不走emit。
 */
export function getBufferedIcon(key: string): string | undefined {
  const k = normalizeId(key);
  if (!k) return undefined;
  const v = iconById.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 仅供测试：读取别名已记忆 `level`。 */
export function __getIconStoreLevel(id: string): number | undefined {
  if (typeof id !== 'string') return undefined;
  return iconLevelById.get(normalizeId(id));
}

/** 内部：删缓冲 + level 记忆（不扇出，供 `applyBadgeHit` 批量单事件用）。 */
function deleteBufferedIcon(key: string): void {
  const k = normalizeId(key);
  if (!k) return;
  iconById.delete(k);
  iconLevelById.delete(k);
}

/** L5 显式清零：用户手动切到空徽章时清掉该键缓冲（含 level 记忆），
 * 否则后续 `assemble/sticky` 经缓冲回读会复活旧图。常规 L5 一律走
 * `admitIconHit({ icon:'', level:5 })`（批量扇出）；直接调此亦经同一读侧扇出
 * （单键 `''/5` 事件：清零必须通知列表/镜像，防富卡 stale）。
 * 订阅回调只做读侧合并，不得再调写口（防递归）。 */
export function clearBufferedIcon(key: string): void {
  const k = normalizeId(key);
  if (!k) return;
  const had = iconById.has(k) || iconLevelById.has(k);
  void had;
  deleteBufferedIcon(k);
  try {
    invalidateIconCache(k);
  } catch {
    // 失效失败不阻塞扇出
  }
  notifyIconWrites([k], '', 5);
}
