/**
 * 前端运行时图标状态管理：统一接收 `admitIconHit` 写入，按世代门控与优先级单调规则过滤后
 * 更新内存缓冲、触发远端图标预热并向订阅方广播变更。
 */
import type { AppSummary } from '../types';
import { normalizeId, normalizeIdSet } from './normalizeId';
import { getOrFetchIcon } from './api/catalog';

/** 空图标判定 SSOT（读透适配统一用此件，不各自 `trim()===''` 散写）。 */
function isEmptyIcon(icon: unknown): boolean {
  return typeof icon !== 'string' || icon.trim() === '';
}

/** 校验图标级别（1..5，其中 5 为用户显式切空的徽章级别）。 */
function isPureLevel(level: unknown): level is number {
  return (
    typeof level === 'number' &&
    Number.isFinite(level) &&
    Number.isInteger(level) &&
    level >= 1 &&
    level <= 5
  );
}

/** 比较图标优先级（数字越小越优，L5 显式徽章最高）；返回负数表示 `a` 更优。 */
function compareIconPriority(a: number, b: number): number {
  const rank = (l: number): number => (l === 5 ? 0 : l);
  return rank(a) - rank(b);
}

/** 图标事件上下文（后端 `icons::IconFetchCtx` 的前端镜像）。 */
interface IconHitContext {
  kind: 'search' | 'trend' | 'starred' | string;
  search_id?: string;
  board?: string;
  gen?: number;
}

/** 图标命中（`id` 应用标识 + `icon/level/via/context`）。 */
interface IconHit {
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

interface AdmitIconHitArgs extends IconHit {
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

interface AdmitIconHitResult {
  accepted: boolean;
  targets?: string[];
  icon?: string;
  level?: number;
  /** `true`=已入队 `queueIconFetches→get_or_fetch_icon`；`false`=M1纯内存（`data:`/非远端 m2）。 */
  queued?: boolean;
  reason?: string;
}

/** 替换列表中指定 id 的图标；未命中或未变化时返回原数组引用。 */
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

/** 订阅图标写入扇出（订阅回调只做读侧合并，不得再调 `admitIconHit`）。 */
interface IconWriteEvent {
  targets: string[];
  icon: string;
  level?: number;
}
type IconWriteSubscriber = (hit: IconWriteEvent) => void;
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
  iconDataSubscribers.clear();
}

type IconDataReadySubscriber = (keys: string[]) => void;
const iconDataSubscribers = new Set<IconDataReadySubscriber>();

/** 订阅远端图标落盘 `data:` 就绪通知（用于 `<AppIcon>` 切换本地缓存及错误恢复）。 */
export function subscribeIconDataReady(fn: IconDataReadySubscriber): () => void {
  iconDataSubscribers.add(fn);
  return () => {
    iconDataSubscribers.delete(fn);
  };
}

function notifyIconDataReady(keys: string[]): void {
  if (iconDataSubscribers.size === 0 || keys.length === 0) return;
  for (const fn of [...iconDataSubscribers]) {
    try {
      fn(keys);
    } catch {
      // 单订阅失败不阻塞其余订阅
    }
  }
}

function resolveIconTargets(hit: Pick<IconHit, 'id'>): string[] {
  return normalizeIdSet([hit?.id]);
}

/** 仅 `http(s)` 才算可落盘远端（`data:` 另行内存通道，其余一律丢弃）。 */
export function isRemoteHttpIconUrl(icon: unknown): boolean {
  if (typeof icon !== 'string') return false;
  const u = icon.trim().toLowerCase();
  return u.startsWith('http://') || u.startsWith('https://');
}

/** URL 键按去空白小写比较（不走 `normalizeId`，避免同仓不同图标文件互串缓存）。 */
function normalizeIconKey(key: unknown): string {
  if (typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:')) {
    return lower;
  }
  return normalizeId(trimmed);
}

function preferNonEmptyIcon(
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

/** 合并图标：保留已有非空图标并回读 M1 缓冲；若已切为 L5 显式空徽章则保持空串。 */
export function resolveIconWithBuffer(cur: AppSummary | undefined, incoming: AppSummary): AppSummary {
  const coordKey =
    incoming.owner && incoming.repo
      ? `${normalizeId(incoming.owner)}/${normalizeId(incoming.repo)}`
      : '';
  const idKey = typeof incoming.id === 'string' ? normalizeId(incoming.id) : '';
  // L5 显式空徽章保护：若该应用已切至 L5 空徽章且 incoming 为空，直接保留空串，不从旧 cur 复活旧图
  if (
    isEmptyIcon(incoming.icon) &&
    ((coordKey && iconLevelById.get(coordKey) === 5) || (idKey && iconLevelById.get(idKey) === 5))
  ) {
    return { ...incoming, icon: '' };
  }
  const merged = preferNonEmptyIcon(cur, incoming);
  if (!isEmptyIcon(merged.icon)) return merged;
  const buffered =
    (coordKey ? getBufferedIcon(coordKey) : undefined) ??
    (idKey ? getBufferedIcon(idKey) : undefined);
  if (buffered && !isEmptyIcon(buffered)) {
    return { ...merged, icon: buffered };
  }
  return merged;
}

/** 合并趋势镜像字典中对应 id/别名的图标（允许 L5 空串覆盖）。 */
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

/** 按规范 id 记忆图标优先级与 M1 图标缓冲（供空值回退）。 */
const iconLevelById = new Map<string, number>();
const iconById = new Map<string, string>();

/** 落盘图标的 `data:` 展示缓存（key 为远端 URL 或规范 id）。 */
const iconDataCache = new Map<string, string>();
const iconPendingPromises = new Map<string, Promise<string>>();

/** 图标内存容器与预热队列的单表条数上限（FIFO 淘汰，已落盘条目淘汰后由后端重新读取）。 */
export const ICON_STORE_MAX_ENTRIES = 600;

function trimBoundedMap<T>(map: Map<string, T>): void {
  while (map.size > ICON_STORE_MAX_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function rememberIconLevel(key: string, level: number): void {
  iconLevelById.set(key, level);
  trimBoundedMap(iconLevelById);
}

function rememberBufferedIcon(key: string, icon: string): void {
  iconById.set(key, icon);
  trimBoundedMap(iconById);
}

function rememberIconData(key: string, dataUri: string): void {
  iconDataCache.set(key, dataUri);
  trimBoundedMap(iconDataCache);
}

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

/** 世代门控快照：`kind` + `search_id`（搜索）/`board`+`gen`（榜单）/`gen`（Star）。 */
interface GenerationGate {
  kind: string;
  search_id?: string | null;
  board?: string | null;
  gen?: number | null;
  minGen?: number;
}

/** 趋势 / Star 列表世代门控槽：用于拦截切榜、强刷或换账号时仍在途的旧事件。 */
interface ViewGateSlot {
  active: { board?: string; gen?: number } | null;
  minGenWatermark: number;
  highestSeenGen: number;
}

const viewGates: Record<'trend' | 'starred', ViewGateSlot> = {
  trend: { active: null, minGenWatermark: 0, highestSeenGen: 0 },
  starred: { active: null, minGenWatermark: 0, highestSeenGen: 0 },
};

function advanceGateWatermark(slot: ViewGateSlot): void {
  slot.minGenWatermark = Math.max(slot.minGenWatermark, slot.highestSeenGen);
}

function resetViewGateSlot(slot: ViewGateSlot): void {
  slot.active = null;
  slot.minGenWatermark = 0;
  slot.highestSeenGen = 0;
}

export function setActiveTrendIconGate(gate: { board: string; gen?: number } | null): void {
  const slot = viewGates.trend;
  if (!gate) {
    advanceGateWatermark(slot);
    slot.active = null;
    return;
  }
  if (slot.active?.board && normalizeId(slot.active.board) !== normalizeId(gate.board)) {
    advanceGateWatermark(slot);
  }
  slot.active = { board: gate.board, gen: gate.gen };
}

export function advanceTrendIconGateOnRefresh(): void {
  advanceGateWatermark(viewGates.trend);
}

export function setActiveStarredIconGate(gate: { gen?: number } | null): void {
  viewGates.starred.active = gate ? { gen: gate.gen } : null;
}

export function advanceStarredIconGateOnNewQuery(): void {
  advanceGateWatermark(viewGates.starred);
}

export interface IconReadyBridgeCallbacks {
  onBeforeAdmit?: (payload: IconReadyPayload) => void;
  getCurrentSearchId?: () => string;
  getCurrentIcon?: (id: string) => string | undefined;
}

let iconReadyRefCount = 0;
let iconReadyGen = 0;
let iconReadyUnlisten: (() => void) | null = null;
let activeBridgeCallbacks: IconReadyBridgeCallbacks | null = null;

function releaseIconReadyHandle(): void {
  iconReadyGen += 1;
  const unlisten = iconReadyUnlisten;
  iconReadyUnlisten = null;
  if (unlisten) {
    try {
      unlisten();
    } catch {
      // 解绑幂等
    }
  }
}

/** 引用计数共享 `zstore://icon-ready` 订阅，多消费方挂载时仅注册单条 IPC 监听。 */
export function ensureIconReadySubscription(
  subscribe: (cb: (payload: IconReadyPayload) => void) => Promise<() => void>,
  callbacks?: IconReadyBridgeCallbacks,
): () => void {
  const ownsCallbacks = Boolean(callbacks);
  if (callbacks) {
    activeBridgeCallbacks = callbacks;
  }
  iconReadyRefCount += 1;
  if (iconReadyRefCount === 1) {
    const myGen = ++iconReadyGen;
    void subscribe((payload) => {
      if (iconReadyGen !== myGen || iconReadyRefCount === 0) return;
      const raw = (payload ?? {}) as unknown as Record<string, unknown>;
      const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      const ctx = (raw['context'] ?? null) as IconHitContext | null;
      activeBridgeCallbacks?.onBeforeAdmit?.(payload);
      admitIconHit({
        id: asStr(raw['id']),
        icon: asStr(raw['icon']),
        level: typeof raw['level'] === 'number' ? (raw['level'] as number) : undefined,
        via: asStr(raw['via']),
        context: ctx,
        currentSearchId: activeBridgeCallbacks?.getCurrentSearchId?.(),
        getCurrentIcon: activeBridgeCallbacks?.getCurrentIcon,
      });
    })
      .then((unlisten) => {
        if (iconReadyGen !== myGen || iconReadyRefCount === 0) {
          try {
            unlisten();
          } catch {
            // 迟到解绑忽略异常
          }
          return;
        }
        iconReadyUnlisten = unlisten;
      })
      .catch(() => {});
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (ownsCallbacks && activeBridgeCallbacks === callbacks) {
      activeBridgeCallbacks = null;
    }
    iconReadyRefCount = Math.max(0, iconReadyRefCount - 1);
    if (iconReadyRefCount === 0) {
      releaseIconReadyHandle();
    }
  };
}

/** 失效 `iconDataCache`、在途请求及预热队列中指定键及其关联 URL/id 别名。 */
function invalidateIconCache(key?: string): void {
  if (!key) {
    iconDataCache.clear();
    iconPendingPromises.clear();
    iconPendingAliases.clear();
    iconPreloadQueue.clear();
    iconPreloadScheduled = false;
    return;
  }
  const norm = normalizeIconKey(key);
  const candidates = new Set<string>([key, norm]);
  // id→URL 别名经店内 `iconById` 单源回查（无并行 map）。
  const mappedUrl = norm ? iconById.get(norm) : undefined;
  if (typeof mappedUrl === 'string' && mappedUrl) {
    candidates.add(mappedUrl);
    candidates.add(normalizeIconKey(mappedUrl));
  }
  // URL→id 反查：同 URL 的别名 data 态一并失效。
  if (norm) {
    for (const [id, url] of iconById.entries()) {
      if (normalizeIconKey(url) === norm || url === key) {
        candidates.add(id);
        candidates.add(normalizeIconKey(id));
      }
    }
  }
  for (const c of candidates) {
    if (!c) continue;
    iconDataCache.delete(c);
    iconPendingPromises.delete(c);
    iconPendingAliases.delete(c);
    iconPreloadQueue.delete(c);
  }
}

/** 读取已落盘缓存的图标 `data:` URI。 */
export function getCachedIconDataUri(key: string): string | undefined {
  if (typeof key !== 'string' || key === '') return undefined;
  const n = normalizeIconKey(key);
  return iconDataCache.get(key) ?? (n ? iconDataCache.get(n) : undefined);
}

/** 将远端图标加入同 tick 合并预热队列（跳过 `data:` 与退避期内 URL，失败后退避 30s）。 */
function queueIconFetches(items: (string | { id?: string; icon: string })[]): void {
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
        if (!iconDataCache.has(id)) rememberIconData(id, cached);
        const nid = normalizeId(id);
        if (nid && !iconDataCache.has(nid)) rememberIconData(nid, cached);
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
          trimBoundedMap(iconPendingAliases);
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
      trimBoundedMap(iconPreloadQueue);
    }
    if (typeof id === 'string' && id !== '') {
      queued.add(id);
      const nid = normalizeId(id);
      if (nid) queued.add(nid);
    }
  }
  schedulePreloadDrain();
}

/** 列表组装图标预热单批上限。 */
export const ASSEMBLED_ROW_ICON_QUEUE_CAP = 30;

/** 判断 URL 是否已缓存或已在预热队列/在途请求中（退避期内不算已覆盖，以便允许重试）。 */
export function isIconPersistedOrQueued(url: unknown): boolean {
  if (typeof url !== 'string' || url === '') return false;
  const cached = iconDataCache.get(url);
  if (typeof cached === 'string' && cached !== '') return true;
  const nid = normalizeIconKey(url);
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
  const now = Date.now();
  const backoff = iconPreloadBackoffUntil.get(url);
  if (typeof backoff === 'number') {
    if (backoff > now) return true;
    iconPreloadBackoffUntil.delete(url);
  }
  if (nid && nid !== url) {
    const backoffNorm = iconPreloadBackoffUntil.get(nid);
    if (typeof backoffNorm === 'number') {
      if (backoffNorm > now) return true;
      iconPreloadBackoffUntil.delete(nid);
    }
  }
  return false;
}

/** 该远端图标的后端获取是否处于失败退避期（URL 键与归一键双查）。 */
export function isIconInPreloadBackoff(url: string): boolean {
  if (!url) return false;
  const now = Date.now();
  const direct = iconPreloadBackoffUntil.get(url);
  if (typeof direct === 'number' && direct > now) return true;
  const norm = normalizeIconKey(url);
  if (norm && norm !== url) {
    const byNorm = iconPreloadBackoffUntil.get(norm);
    if (typeof byNorm === 'number' && byNorm > now) return true;
  }
  return false;
}

/** `<AppIcon>` 挂载时按需入队读取本地磁盘缓存（仅在真实 Tauri IPC 且内存未命中时入队）。 */
export function requestIconLocalCache(appId: string | undefined, iconUrl: string): void {
  if (typeof window === 'undefined') return;
  const tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof tauriInternals?.invoke !== 'function') return;
  if (!isRemoteHttpIconUrl(iconUrl)) return;
  if (getCachedIconDataUri(iconUrl) || (appId && getCachedIconDataUri(appId))) return;
  queueIconFetches([appId ? { id: appId, icon: iconUrl } : iconUrl]);
}

/** 远端直连触发 `onError` 时清除退避并立即向后端请求缓存读取，成功后通过 `subscribeIconDataReady` 恢复。 */
export function retryIconFromLocalOrBackend(appId: string | undefined, iconUrl: string): void {
  if (!isRemoteHttpIconUrl(iconUrl)) return;
  iconPreloadBackoffUntil.delete(iconUrl);
  const norm = normalizeIconKey(iconUrl);
  if (norm) iconPreloadBackoffUntil.delete(norm);
  queueIconFetches([appId ? { id: appId, icon: iconUrl } : iconUrl]);
}

/** 对已组装行中的远端图标入队落盘预热（跳过已覆盖项，最多取 `ASSEMBLED_ROW_ICON_QUEUE_CAP` 条）。 */
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
    const batchKey = normalizeIconKey(icon) || icon;
    if (seenInBatch.has(batchKey)) continue;
    seenInBatch.add(batchKey);
    seenInBatch.add(icon);
    const id = typeof row?.id === 'string' ? row.id : undefined;
    batch.push(id === undefined ? { icon } : { id, icon });
  }
  if (batch.length > 0) queueIconFetches(batch);
}

/** 首屏前 30 个图标预热。 */
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
          if (id && !iconDataCache.has(id)) rememberIconData(id, cached);
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
        trimBoundedMap(iconPendingAliases);
      }
      for (const id of ids) if (id) aliases.add(id);
      continue;
    }
    const backoffUntil = iconPreloadBackoffUntil.get(url);
    if (typeof backoffUntil === 'number' && backoffUntil > Date.now()) continue;
    startIconFetch(url, ids);
  }
}

/** 清理在途 Promise 与别名并返回该 URL 关联的 URL 键与 id 键。 */
function settleIconFetch(
  url: string,
  fallbackAliases: Set<string>,
): { urlKeys: string[]; idKeys: string[] } {
  const aliases = iconPendingAliases.get(url) ?? fallbackAliases;
  iconPendingPromises.delete(url);
  iconPendingAliases.delete(url);
  const urlKeys: string[] = [url];
  const normUrl = normalizeIconKey(url);
  if (normUrl && normUrl !== url) urlKeys.push(normUrl);
  const idKeys: string[] = [];
  for (const id of aliases) {
    if (!id) continue;
    idKeys.push(id);
    const nid = normalizeId(id);
    if (nid && nid !== id) idKeys.push(nid);
  }
  return { urlKeys, idKeys };
}

function startIconFetch(url: string, ids: Set<string>): void {
  const aliasSet = new Set<string>(ids);
  iconPendingAliases.set(url, aliasSet);
  trimBoundedMap(iconPendingAliases);
  // 多别名同 URL 取首个非空 id 透传后端（其余经成功扇出写缓存）。
  let firstId: string | null = null;
  for (const id of aliasSet) {
    if (id) {
      firstId = id;
      break;
    }
  }
  const p = getOrFetchIcon(firstId ?? undefined, url)
    .then((dataUri) => {
      // 非 data: 结果视同失败：走退避 + 唤醒，避免等待后端的 <AppIcon> 永远停在占位。
      if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
        throw new Error('icon fetch returned no data uri');
      }
      const keys = settleIconFetch(url, aliasSet);
      rememberIconData(url, dataUri);
      for (const id of keys.idKeys) rememberIconData(id, dataUri);
      iconPreloadBackoffUntil.delete(url);
      notifyIconDataReady([...keys.urlKeys, ...keys.idKeys]);
      return dataUri;
    })
    .catch(() => {
      // 预热失败静默吞掉（不产生未处理拒绝；退避后可后台重预热）。
      const keys = settleIconFetch(url, aliasSet);
      iconPreloadBackoffUntil.set(url, Date.now() + ICON_PRELOAD_BACKOFF_MS);
      trimBoundedMap(iconPreloadBackoffUntil);
      // 唤醒等待后端结果的 <AppIcon>：退避期内它们回退为 WebView 直连 <img>。
      notifyIconDataReady([...keys.urlKeys, ...keys.idKeys]);
      return '';
    });
  iconPendingPromises.set(url, p);
  trimBoundedMap(iconPendingPromises);
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

/** 仅供测试：模拟落盘写 `iconDataCache`（`queueAssembledRowIcons` 让位断言用；经有界写口）。 */
export function __setIconDataCacheForTests(key: string, dataUri: string): void {
  if (typeof key !== 'string' || key === '') return;
  if (typeof dataUri !== 'string' || dataUri === '') return;
  rememberIconData(key, dataUri);
  const norm = normalizeIconKey(key);
  notifyIconDataReady(norm && norm !== key ? [key, norm] : [key]);
}

/** 仅供测试：有界容器现存量（有界断言用）。 */
export function __getIconStoreSizesForTests(): {
  levelById: number;
  iconById: number;
  dataCache: number;
  preloadQueue: number;
  pendingAliases: number;
  pendingPromises: number;
  preloadBackoff: number;
} {
  return {
    levelById: iconLevelById.size,
    iconById: iconById.size,
    dataCache: iconDataCache.size,
    preloadQueue: iconPreloadQueue.size,
    pendingAliases: iconPendingAliases.size,
    pendingPromises: iconPendingPromises.size,
    preloadBackoff: iconPreloadBackoffUntil.size,
  };
}

/** 处理 L5 显式空徽章写入：清除图标记忆与展示缓存，并将空串写透列表及订阅方。 */
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

/** Incoming generation snapshot from `context` (normalized; empty means no gate). */
function resolveIncomingGate(ctx: IconHitContext | null | undefined): GenerationGate {
  return {
    kind: ctx && typeof ctx.kind === 'string' ? ctx.kind.trim().toLowerCase() : '',
    search_id:
      ctx && typeof ctx.search_id === 'string' && ctx.search_id
        ? ctx.search_id
        : '',
    board: ctx && typeof ctx.board === 'string' ? ctx.board : '',
    gen: ctx && typeof ctx.gen === 'number' && Number.isFinite(ctx.gen) ? ctx.gen : undefined,
  };
}

function checkGenAndWatermark(
  incomingGen: number | null | undefined,
  expectedGen: number | null | undefined,
  minGen: number | undefined,
  reason: string,
): string | undefined {
  if (typeof incomingGen !== 'number') return undefined;
  if (typeof expectedGen === 'number' && incomingGen !== expectedGen) return reason;
  if (typeof minGen === 'number' && minGen > 0 && incomingGen <= minGen) return reason;
  return undefined;
}

/** Expected generation snapshot (scoped by `kind`, using live getters / active view gates). */
function resolveExpectedGate(args: AdmitIconHitArgs, incoming: GenerationGate): GenerationGate {
  if (incoming.kind === 'starred') {
    return {
      kind: 'starred',
      gen: viewGates.starred.active?.gen,
      minGen: viewGates.starred.minGenWatermark,
    };
  }
  const activeTrend = viewGates.trend.active;
  let expectedGen: number | undefined;
  try {
    if (typeof args.getBoardGen === 'function') {
      const key =
        normalizeId(args.board) ||
        normalizeId(incoming.board) ||
        normalizeId(activeTrend?.board) ||
        undefined;
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
  if (incoming.kind === 'trend') {
    if (expectedGen === undefined && activeTrend?.gen !== undefined) {
      expectedGen = activeTrend.gen;
    }
    const board =
      typeof args.board === 'string' && args.board
        ? args.board
        : (activeTrend?.board ?? '');
    return {
      kind: 'trend',
      board,
      gen: expectedGen,
      minGen: viewGates.trend.minGenWatermark,
    };
  }
  return {
    kind: incoming.kind,
    search_id: resolveCurrentSearchId(args),
    board: typeof args.board === 'string' ? args.board : '',
    gen: expectedGen,
  };
}

/** Generation staleness scoped by `kind` (`search` / `trend` / `starred`). */
function findStaleGateReason(
  incoming: GenerationGate,
  expected: GenerationGate,
): string | undefined {
  if (incoming.kind === 'starred' || incoming.kind === 'trend') {
    if (incoming.kind === 'trend') {
      const ib = normalizeId(incoming.board);
      const eb = normalizeId(expected.board);
      if (ib && eb && ib !== eb) return 'stale-board';
    }
    const reason = incoming.kind === 'starred' ? 'stale-starred-gen' : 'stale-board-gen';
    return checkGenAndWatermark(incoming.gen, expected.gen, expected.minGen, reason);
  }
  const a = typeof incoming.search_id === 'string' ? incoming.search_id : '';
  const b = typeof expected.search_id === 'string' ? expected.search_id : '';
  if (a && b && a !== b) return 'stale-search-id';
  const ib = normalizeId(incoming.board);
  const eb = normalizeId(expected.board);
  if (ib && eb && ib !== eb) return 'stale-board';
  if (
    incoming.gen !== undefined &&
    expected.gen !== undefined &&
    incoming.gen !== expected.gen
  ) {
    return 'stale-board-gen';
  }
  return undefined;
}

/** Pure level input (only 1..5 valid; otherwise absent and never advances memory). */
function resolvePureLevel(args: AdmitIconHitArgs): number | undefined {
  const level =
    typeof args.level === 'number' && Number.isFinite(args.level) ? args.level : undefined;
  return isPureLevel(level) ? (level as number) : undefined;
}

/** Cache channel (`live|m2`, normalized; orthogonal to level, never participates in comparison). */
function resolveVia(args: AdmitIconHitArgs): string {
  return typeof args.via === 'string' ? args.via.trim().toLowerCase() : '';
}

/** Memory-only icons (`data:` always; `m2` only without remote http, otherwise heals via persist path). */
function isMemoryOnlyIcon(icon: string, via: string): boolean {
  return icon.startsWith('data:') || (via === 'm2' && !isRemoteHttpIconUrl(icon));
}

/** Best remembered pure level across targets (lower wins, L5 ranks highest). */
function findBestStoredLevel(targets: string[]): number | undefined {
  let best: number | undefined;
  for (const t of targets) {
    const s = iconLevelById.get(t);
    if (s === undefined) continue;
    if (best === undefined || compareIconPriority(s, best) < 0) best = s;
  }
  return best;
}

/** 提取可落盘的远端 http(s) 图标 URL（排除 `data:` 与空值）。 */
function pickPersistIconUrl(icon: string): string {
  const value = typeof icon === 'string' ? icon.trim() : '';
  if (value === '' || value.startsWith('data:')) return '';
  return isRemoteHttpIconUrl(value) ? value : '';
}

/** Best-effort cache invalidation across targets (one failure never blocks the rest). */
function invalidateTargets(targets: string[]): void {
  for (const t of targets) {
    try {
      invalidateIconCache(t);
    } catch {
      // 缓存失效失败不阻塞内存写透
    }
  }
}

/** Best-effort list write-through across targets (one failure never blocks the rest). */
function patchTargets(
  targets: string[],
  icon: string,
  patch?: AdmitIconHitArgs['patch'],
): void {
  if (typeof patch !== 'function') return;
  for (const t of targets) {
    try {
      patch(t, icon);
    } catch {
      // 单别名 patch 失败不阻塞其余别名
    }
  }
}

/** Empty-icon path (badge handled earlier): never overwrites a real icon, otherwise a noop drop. */
function admitEmptyHit(
  targets: string[],
  getCurrentIcon?: AdmitIconHitArgs['getCurrentIcon'],
): AdmitIconHitResult {
  const keep = hasExistingRealIcon(targets, getCurrentIcon);
  return { accepted: false, targets, reason: keep ? 'empty-keeps-real' : 'empty-noop' };
}

/** Memory-only path (`data:`/non-remote m2): invalidate + memory write + patch, no preload, no level advance. */
function admitMemoryOnlyHit(
  targets: string[],
  icon: string,
  pureLevel: number | undefined,
  patch?: AdmitIconHitArgs['patch'],
): AdmitIconHitResult {
  const isData = icon.startsWith('data:');
  for (const t of targets) {
    try {
      invalidateIconCache(t);
    } catch {
      // 缓存失效失败不阻塞内存写透
    }
    rememberBufferedIcon(t, icon);
    if (isData) {
      rememberIconData(t, icon);
    }
  }
  patchTargets(targets, icon, patch);
  notifyIconWrites(targets, icon, pureLevel);
  if (isData) {
    notifyIconDataReady(targets);
  }
  return {
    accepted: true,
    targets,
    icon,
    level: pureLevel,
    queued: false,
    reason: isData ? 'data-memory-only' : 'm2-memory-only',
  };
}

/** Remote persist path (http only): advances level memory (non-m2), preloads, patches, remembers, fans out. */
function admitRemoteHit(
  targets: string[],
  icon: string,
  pureLevel: number | undefined,
  via: string,
  nextLevel: number | undefined,
  patch?: AdmitIconHitArgs['patch'],
): AdmitIconHitResult {
  const persistUrl = pickPersistIconUrl(icon);
  if (persistUrl === '') {
    return { accepted: false, targets, icon, level: pureLevel, reason: 'non-remote-dropped' };
  }
  if (nextLevel !== undefined && via !== 'm2') {
    for (const t of targets) rememberIconLevel(t, nextLevel);
  }
  invalidateTargets(targets);
  try {
    queueIconFetches(targets.map((t) => ({ id: t, icon: persistUrl })));
  } catch {
    // 预热失败不阻塞列表写透（AppIcon 侧按 URL 直显兜底）
  }
  patchTargets(targets, persistUrl, patch);
  for (const t of targets) rememberBufferedIcon(t, persistUrl);
  notifyIconWrites(targets, persistUrl, pureLevel);
  return { accepted: true, targets, icon: persistUrl, level: pureLevel, queued: true };
}

/** 唯一图标写入入口：依次执行 L5 徽章处理、世代门控、优先级单调比较与内存/远端分发。 */
export function admitIconHit(args: AdmitIconHitArgs): AdmitIconHitResult {
  if (!args || typeof args !== 'object') return { accepted: false, reason: 'empty-hit' };

  const targets = resolveIconTargets(args);
  if (targets.length === 0) return { accepted: false, reason: 'missing-target' };

  const rawIcon = typeof args.icon === 'string' ? args.icon.trim() : '';
  if (rawIcon === '' && typeof args.level === 'number' && args.level === 5) {
    return applyBadgeHit(targets, args.patch);
  }
  if (rawIcon === '') {
    return admitEmptyHit(targets, args.getCurrentIcon);
  }
  const icon = rawIcon;

  const incoming = resolveIncomingGate(args.context ?? null);
  const expected = resolveExpectedGate(args, incoming);
  const stale = findStaleGateReason(incoming, expected);
  if (stale) return { accepted: false, targets, icon, reason: stale };
  if ((incoming.kind === 'trend' || incoming.kind === 'starred') && typeof incoming.gen === 'number') {
    const slot = viewGates[incoming.kind];
    slot.highestSeenGen = Math.max(slot.highestSeenGen, incoming.gen);
  }

  const pureLevel = resolvePureLevel(args);
  const via = resolveVia(args);
  let nextLevel: number | undefined;
  if (pureLevel !== undefined) {
    const currentBest = findBestStoredLevel(targets);
    if (currentBest !== undefined && compareIconPriority(pureLevel, currentBest) > 0) {
      return { accepted: false, targets, icon, level: pureLevel, reason: 'level-stale' };
    }
    nextLevel = pureLevel;
  }

  // data: 与非远端 m2 仅写入内存；http(s) 远端走预热落盘分支
  if (isMemoryOnlyIcon(icon, via)) {
    return admitMemoryOnlyHit(targets, icon, pureLevel, args.patch);
  }

  return admitRemoteHit(targets, icon, pureLevel, via, nextLevel, args.patch);
}

/** 仅供测试：清空 `level`/图标记忆（含展示数据态与世代门控态）。 */
export function __resetIconStoreForTests(): void {
  iconLevelById.clear();
  iconById.clear();
  iconDataCache.clear();
  iconPendingPromises.clear();
  iconPendingAliases.clear();
  iconPreloadQueue.clear();
  iconPreloadBackoffUntil.clear();
  iconPreloadScheduled = false;
  resetViewGateSlot(viewGates.trend);
  resetViewGateSlot(viewGates.starred);
  iconReadyRefCount = 0;
  activeBridgeCallbacks = null;
  releaseIconReadyHandle();
}

/** 读取 M1 图标内存缓冲中的非空图标（`admitIconHit` 为唯一写口）。 */
export function getBufferedIcon(key: string): string | undefined {
  const k = normalizeId(key);
  if (!k) return undefined;
  const v = iconById.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 内部：删缓冲 + level 记忆（不扇出，供 `applyBadgeHit` 批量单事件用）。 */
function deleteBufferedIcon(key: string): void {
  const k = normalizeId(key);
  if (!k) return;
  iconById.delete(k);
  iconLevelById.delete(k);
}

/** 图标轮换结果（`restore_or_fetch_icon_cycle` / `cycle_app_icon`）中准入所需的字段。 */
export interface IconCycleLike {
  url?: unknown;
  remote_url?: unknown;
  level?: unknown;
}

/** 提取轮换结果 `remote_url` 的 http(s) 真值，非法或 `data:` 一律空串。 */
export function resolveRemoteIconUrl(cycle: { remote_url?: unknown } | null | undefined): string {
  const remote = typeof cycle?.remote_url === 'string' ? cycle.remote_url.trim() : '';
  return isRemoteHttpIconUrl(remote) ? remote : '';
}

/** 轮换结果的可持久化 URL：`remote_url` 优先，其次 http(s) 的 `url`；`data:` 与空值为空串。 */
export function pickCyclePersistIconUrl(cycle: IconCycleLike | null | undefined): string {
  const remote = resolveRemoteIconUrl(cycle);
  if (remote !== '') return remote;
  const url = typeof cycle?.url === 'string' ? cycle.url.trim() : '';
  return isRemoteHttpIconUrl(url) ? url : '';
}

/**
 * `Confirmed Icon` 轮换结果准入（ADR-0015）：
 * - 可持久化 URL 携带轮换层级经 `admitIconHit` 写透；
 * - 无可持久化 URL 且 `level === 5`：显式首字母徽标定格广播；
 * - 仅有 `data:`：不写入共享层，留给调用方即时展示；
 * - 普通空值丢弃，保留现有占位。
 */
export function admitIconCycleResult(
  appId: string,
  cycle: IconCycleLike | null | undefined,
  opts?: { patch?: AdmitIconHitArgs['patch'] },
): AdmitIconHitResult {
  if (!cycle || typeof cycle !== 'object') return { accepted: false, reason: 'empty-hit' };
  const level =
    typeof cycle.level === 'number' && Number.isFinite(cycle.level) ? cycle.level : undefined;
  const persist = pickCyclePersistIconUrl(cycle);
  if (persist !== '') {
    return admitIconHit({ id: appId, icon: persist, level, patch: opts?.patch });
  }
  const url = typeof cycle.url === 'string' ? cycle.url.trim() : '';
  if (url.startsWith('data:')) return { accepted: false, reason: 'data-transient' };
  if (level === 5) return admitIconHit({ id: appId, icon: '', level: 5, patch: opts?.patch });
  return { accepted: false, reason: 'empty-noop' };
}
