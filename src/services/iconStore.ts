/** 前端图标深 module（deep module，`IconFetch` 前端收口）。
 * module：`services/iconStore` 为图标写唯一深 module；`AppIcon`/`Search List Cache`/
 * `trends/enrich`/`trends/board` 不再自立图标 locality，并行 mem-cache 均已内聚为本 module 内部 seam。
 * interface：唯一对外写 interface 为 `applyHit`（`icon-ready` 统一收口）+ 读侧扇出
 * `subscribeIconWrites`（读侧只合并、不再调写口，不复活窗口总线）；读口 `getBufferedIcon`/
 * `getCachedIconDataUri` 为展示/组装用只读 interface；`stickyIconFor`/`patchIconMirror`/
 * `patchAppIconList` 为erna组装/镜像用的纯合并 interface（内部 seam 的收敛实现，调用方直引、不自立规则）。
 * depth：`applyHit` 内聚 generation gate（`search_id`/`board`+`gen`）+ L-monotone（纯L 1..5，
 * 低不顶高，`via` 正交）+ `via`（`live|m2`，`data:`/`m2` 只进 M1 内存不落盘）+ L5 badge
 *（`icon:'' + level:5` 唯一允许的空覆盖，经 fan-out）+ fan-out（`notifyIconWrites`）。
 * 一次 `IconFetch` 命中经 `icon-ready` 只跳本 module 单 interface，不再跨 `store→cache→enrich→board mirror` 四跳。
 * seam：`applyHit` 为唯一写 seam；`stickyIconFor`（`mergeStickyIcon` + M1 缓冲回读）与
 * `patchIconMirror`（趋势镜像合并）与 `iconDataCache`（`get_or_fetch_icon` 落盘预热内存态）均为内部 seam，
 * 对外不新增写口。`enrich.stickyIconFor`/`board.applyIconChangedToMirror` 的重复 locality 已删除，
 * 调用方经本 module 直引（`adapter` 薄委托保留一版以兼容未迁移的 View，见 `board.ts`）。
 * adapter/leverage/locality：旧四列表工厂 adapter 已删（ica3-11，`App.tsx`
 * 经 `patchAppIconList` + `subscribeIconWrites` 内联四连直写，不经工厂中转）；`AppIcon` 的
 * `appIdToIconMap` 并行 locality 已删（以店内 `iconById` 为单一别名源）；`isRemoteIcon` 留在
 * `AppIcon`（展示判定，与店内 `isRemoteHttpIconUrl` 落盘门控正交，非重复）。
 * 领域词：`IconFetch`（后端 `fetch_icons_stream`）→ `icon-ready`（`zstore://icon-ready`）→
 * 本 module `applyHit`；`Search List Cache`（`searchListCache.ts` 纯前端内存）经 `getBufferedIcon` 回读，
 * 不另立图标规则。`boardReady`/`swrSyncedResult`/`isUpgradePending` 仍为趋势视图内部态，不进本 module。
 * 合规：level 纯L + `via` 正交 + M1/M2 划分遵 ADR-0015；`normalizeId` 归一遵 ADR-0010；
 * 展示图标分层（品牌母版/桌面外壳/运行时矢量）遵 ADR-0005，本 module 只碰运行时列表图标 URL，不碰品牌资产。
 * L5 显式徽章（用户切空，`icon:'' + level:5`）为唯一允许的空覆盖：经 `applyHit`
 * 清记忆 + `patch('')` + 读侧扇出；被动空壳（无 level 5）仍直接丢弃。
 * 读侧扇出（`subscribeIconWrites`）：`applyHit` 受理后通知订阅者（App 四列表/趋势镜像），
 * 写口仍唯一，不复活窗口总线。`clearBufferedIcon` 亦经同一扇出（直接清零亦通知，防富卡 stale，
 * 见 `ecb83e1` 语义；`applyBadgeHit` 内走批量单事件，直接调用走单键事件）。
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

/** 图标命中（`key/id/app_id` 别名 + `icon/level/via/context`）。 */
export interface IconHit {
  /** `key`（小写 `owner/repo`）。 */
  key?: string | null;
  /** `id`（小写 `owner/repo`，与 `app_id` 同值）。 */
  id?: string | null;
  /** 别名：`app_id`（与 `id` 同值）。 */
  app_id?: string | null;
  icon?: string | null;
  /** `level`纯L（2=L2品牌库，3=L3仓库；单调记忆，via正交）。 */
  level?: number | null;
  /** 缓存正交：`live|m2`（M2首屏直填不走emit）。 */
  via?: string | null;
  context?: IconHitContext | null;
  /** 顶层 `search_id`（`context` 缺席时回落用）。 */
  search_id?: string | null;
}

/** 事件载荷（`zstore://icon-ready`，供 `catalog.ts` 订阅打型）。 */
export interface IconReadyPayload {
  key: string;
  id: string;
  icon: string;
  level: number;
  /** 缓存正交：`live|m2`（M2首屏直填不走emit）。 */
  via?: string;
  context: IconHitContext;
}

export interface ApplyHitArgs extends IconHit {
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

export interface ApplyHitResult {
  accepted: boolean;
  targets?: string[];
  icon?: string;
  level?: number;
  /** `true`=走了 `preloadIcons→get_or_fetch_icon` 落盘；`false`=M1纯内存（`data:`/`via=m2`）。 */
  persisted?: boolean;
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
 * 读侧扇出订阅：`applyHit` 受理写入后通知订阅者（App 四列表写透/趋势镜像跟进）。
 * 写口仍唯一是 `applyHit`；订阅回调只做读侧合并，不得再调 `applyHit`（防递归）。
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
 * 归一 key+id 别名：取 `key/id/app_id` 去空 → 归一去重保序。
 */
export function resolveIconTargets(hit: Pick<IconHit, 'key' | 'id' | 'app_id'>): string[] {
  return normalizeIdSet([hit?.key, hit?.id, hit?.app_id]);
}

/** 仅 `http(s)` 才算可落盘远端（`data:` 另行内存通道，其余一律丢弃）。 */
export function isRemoteHttpIconUrl(icon: unknown): boolean {
  if (typeof icon !== 'string') return false;
  const u = icon.trim().toLowerCase();
  return u.startsWith('http://') || u.startsWith('https://');
}

/**
 * icon 粘性 supersede-only 合并（内部 seam 的收敛实现，原 `enrich.stickyIconFor` 的下半）：
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
 * icon 粘性 + M1 缓冲回读（内部 seam 的收敛实现，原 `enrich.stickyIconFor` 全量上移）：
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
 * 趋势镜像图标合并（内部 seam 的收敛实现，原 `board.applyIconChangedToMirror` 全量下移）：
 * incoming 与旧不同即覆盖；L5（`''`）放行内存清零；大小写归一，同时匹配坐标键与
 * `enriched.id` 小写别名（`normalizeId`，遵 ADR-0010）。`board.ts` 仅留薄 adapter 委托，
 * 待 View 迁移至 `subscribeIconWrites` 后删除（`one adapter=hypothetical seam`）。
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
 * 图标展示数据内存态（原 `AppIcon.iconDataCache` 上移为本 module 内部 seam）：
 * `get_or_fetch_icon` 落盘后的 `data:` 直显态，`key` 为远端 URL 或归一 id（小写）。
 * 别名源唯一是店内 `iconById`（`normalizeId`），不再另立 `appIdToIconMap` 并行 locality。
 */
const iconDataCache = new Map<string, string>();
const iconPendingPromises = new Map<string, Promise<string>>();

function resolveCurrentSearchId(args: ApplyHitArgs): string {
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

function hasExistingRealIcon(targets: string[], getCurrentIcon?: ApplyHitArgs['getCurrentIcon']): boolean {
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
 * 展示数据失效（内部 seam，原 `AppIcon.invalidateIconCache` 上移）：
 * 删 `iconDataCache`/`pending` 中该键及其关联 URL/别名态。以店内 `iconById` 为唯一别名源
 * （`normalizeId`，遵 ADR-0010），不再维护并行 `appIdToIconMap`。
 * `AppIcon` 侧仅留薄 adapter 委托（兼容 `useAppSubscriptions` 等未迁移调用方）。
 */
export function invalidateIconCache(key?: string): void {
  if (!key) {
    iconDataCache.clear();
    iconPendingPromises.clear();
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
 * 远端预热（内部 seam，原 `AppIcon.preloadIcons` 上移）：
 * 仅远端（`http(s)`/`data:` 兼容展示判定由调用方保证，此处复用店内落盘门控）走
 * `get_or_fetch_icon` 落盘；`data:` 永不预热；同 URL 去重（`pending` 单飞）。
 * `M1` 纯内存（`data:`/`via=m2`）路径不经此（`applyHit` 内跳过）。
 * 非 Tauri（单测/jsdom/浏览器预览）直接返回（展示回落 URL 直显，不抛错、不产生未处理拒绝）。
 */
export function preloadIcons(items: (string | { id?: string; icon: string })[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (!('__TAURI_INTERNALS__' in window)) return;
  } catch {
    return;
  }
  for (const item of items) {
    const icon = typeof item === 'string' ? item : item.icon;
    const id = typeof item === 'string' ? undefined : item.id;
    if (!icon || iconDataCache.has(icon) || icon.startsWith('data:')) continue;
    if (!isRemoteHttpIconUrl(icon) && !icon.includes('.png') && !icon.includes('.svg') && !icon.includes('.jpg') && !icon.includes('.webp') && !icon.includes('.ico')) continue;
    if (!iconPendingPromises.has(icon)) {
      const p = tauriInvoke<string>('get_or_fetch_icon', { appId: id ?? null, remoteUrl: icon })
        .then((dataUri) => {
          iconDataCache.set(icon, dataUri);
          if (id) {
            iconDataCache.set(id, dataUri);
            const nid = normalizeId(id);
            if (nid) iconDataCache.set(nid, dataUri);
          }
          iconPendingPromises.delete(icon);
          return dataUri;
        })
        .catch(() => {
          // 预热失败静默吞掉（展示回落 URL 直显，不产生未处理拒绝；调用方后台重预热）。
          iconPendingPromises.delete(icon);
          return '';
        });
      iconPendingPromises.set(icon, p);
      // 挂载空 catch 防未处理拒绝（上已吞错，此处再兜底一次）。
      void p.catch(() => undefined);
    }
  }
}

/** 仅供测试：清空展示数据内存态（防跨文件泄漏）。 */
export function __resetIconDataCacheForTests(): void {
  iconDataCache.clear();
  iconPendingPromises.clear();
}

/**
 * 唯一写入口：`icon-ready` 统一收口（M1内存唯一口，经 `getBufferedIcon` 回读）。
 * `level`纯L单调；`data:`/`via=m2`只进M1内存不落盘；M2首屏直填不走emit。
 * L5 显式徽章（`icon:'' + level:5`，用户切空意图）为唯一允许的空覆盖：
 * 清图标+level 记忆（cycle-back 可重接受 L2..L4）+ `invalidate` + `patch('')` + 读侧扇出；
 * 其余空图标一律丢弃（被动空壳保护）。
 * 时机：`invalidateIconCache` 先失效 → `preloadIcons` → `patch` 写透四列表 → 读侧扇出。
 */
/**
 * L5 显式徽章写（`applyHit` 内唯一空覆盖分支）：清图标+level 记忆
 * （`deleteBufferedIcon` 同语义，cycle-back 可重接受 L2..L4，不复活旧图）、
 * `invalidate` 展示数据、`patch('')` 写透、读侧扇出。无网络副作用。
 */
function applyBadgeHit(
  targets: string[],
  patch?: ApplyHitArgs['patch'],
): ApplyHitResult {
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
  return { accepted: true, targets, icon: '', level: 5, persisted: false, reason: 'level5-badge' };
}

export function applyHit(args: ApplyHitArgs): ApplyHitResult {
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

  // 世代门控：过期判断只此一处（搜索走 `search_id`，榜单走 `board`+`gen`）。
  // 内联门控三段：incoming 取 `context` 回落顶层，expected 即时取值回落静态值，双非空不等即过期任一为空即放行。
  const ctx = args.context ?? null;
  const kind = ctx && typeof ctx.kind === 'string' ? ctx.kind.trim().toLowerCase() : '';
  const incoming: GenerationGate = {
    search_id:
      ctx && typeof ctx.search_id === 'string' && ctx.search_id
        ? ctx.search_id
        : typeof args.search_id === 'string'
          ? args.search_id
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
  if (kind === '' || kind === 'search') {
    const a = typeof incoming.search_id === 'string' ? incoming.search_id : '';
    const b = typeof expected.search_id === 'string' ? expected.search_id : '';
    if (a && b && a !== b) stale = 'stale-search-id';
  } else if (kind === 'trend') {
    const ib = normalizeId(incoming.board);
    const eb = normalizeId(expected.board);
    if (ib && eb && ib !== eb) stale = 'stale-board';
    else if (
      incoming.gen !== undefined &&
      expected.gen !== undefined &&
      incoming.gen !== expected.gen
    ) {
      stale = 'stale-board-gen';
    }
  }
  if (stale) return { accepted: false, targets, icon, reason: stale };

  // `level`纯L单调升级：低不顶高，via正交不参与比较（live L2/L3 不因 via 丢）。缺省即放行且不推进记忆。
  // 仅 1..4（1官方/2品牌库/3仓库/4 README）参与记忆；非法值视为缺省。
  const level =
    typeof args.level === 'number' && Number.isFinite(args.level) ? args.level : undefined;
  const pureLevel = isPureLevel(level) ? (level as number) : undefined;
  if (pureLevel !== undefined) {
    let currentMax: number | undefined;
    for (const t of targets) {
      const s = iconLevelById.get(t);
      if (s !== undefined && (currentMax === undefined || s > currentMax)) currentMax = s;
    }
    if (currentMax !== undefined && pureLevel < currentMax) {
      return { accepted: false, targets, icon, level: pureLevel, reason: 'level-stale' };
    }
    const next = currentMax === undefined ? pureLevel : Math.max(currentMax, pureLevel);
    for (const t of targets) iconLevelById.set(t, next);
  }

  // `data:`/`via=m2`只进M1内存不落盘：失效 + patch 内存态，跳过 `preloadIcons`。
  const via = typeof args.via === 'string' ? args.via.trim().toLowerCase() : '';
  if (icon.startsWith('data:') || via === 'm2') {
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
      persisted: false,
      reason: icon.startsWith('data:') ? 'data-memory-only' : 'm2-memory-only',
    };
  }

  // 仅 `remote(http)` 才 `patch state + preloadIcons` 走 `get_or_fetch_icon` 落盘。
  if (!isRemoteHttpIconUrl(icon)) {
    return { accepted: false, targets, icon, level: pureLevel, reason: 'non-remote-dropped' };
  }
  for (const t of targets) {
    try {
      invalidateIconCache(t);
    } catch {
      // 同上
    }
  }
  try {
    preloadIcons(targets.map((t) => ({ id: t, icon })));
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
  return { accepted: true, targets, icon, level: pureLevel, persisted: true };
}

/** 仅供测试：清空 `level`/图标记忆（含展示数据态）。 */
export function __resetIconStoreForTests(): void {
  iconLevelById.clear();
  iconById.clear();
  iconDataCache.clear();
  iconPendingPromises.clear();
}

/**
 * M1内存缓冲读口（经 `iconById`，`applyHit`唯一写口）：`icon-ready` 先到、
 * `enrich` 后到竞态时，`enrich` 组装经此取缓冲实图，空壳不覆盖缓冲实图。
 * `data:`/`via=m2`只走此内存态；M2首屏直填不走emit。
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
 * `applyHit({ icon:'', level:5 })`（批量扇出）；直接调此亦经同一读侧扇出
 * （单键 `''/5` 事件，`ecb83e1` 语义：清零必须通知列表/镜像，防富卡 stale）。
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
