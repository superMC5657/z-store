/** 前端图标唯一写入口（C1 深核前端件）。
 * level纯L单调（1=L1官方/2=L2品牌库/3=L3仓库/4=L4 README，via正交live|m2）；
 * M1=内存（iconStore/searchListCache/enrich经getBufferedIcon/applyHit唯一口）；
 * M2=DB（via=m2首屏直填，不走emit）；`data:`永不落盘只进M1内存。
 * 缝：`applyHit` 为唯一写口；`AppIcon`/`useSearchState.assembleOnlineRowsWithIcons`/
 * `enrich.stickyIconFor` 为读透适配（经 `getBufferedIcon`/`applyHit`，不自立空值规则）；四列表写透（apps/onlineApps/recentlyViewedApps/
 * favoriteExtraApps）经 `patch` 注入（见 `createFourListPatch`）。
 * L5 显式徽章（用户切空，`icon:'' + level:5`）为唯一允许的空覆盖：经 `applyHit`
 * 清记忆 + `patch('')` + 读侧扇出；被动空壳（无 level 5）仍直接丢弃。
 * 读侧扇出（`subscribeIconWrites`）：`applyHit` 受理后通知订阅者（App 四列表/趋势镜像），
 * 写口仍唯一，不复活窗口总线。
 */
import { invalidateIconCache, preloadIcons } from '../components/AppIcon';
import type { AppSummary } from '../types';
import { normalizeId, normalizeIdSet } from './normalizeId';

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
 * icon 粘性 supersede-only 合并（`enrich.ts` 图标半区的收敛实现）：
 * 旧图标非空 + 回填图标空 → 沿用旧图标；其余一律采用回填值。
 */
export function mergeStickyIcon(
  cur: AppSummary | undefined,
  incoming: AppSummary,
): AppSummary {
  const curIcon = cur && typeof cur.icon === 'string' ? cur.icon : '';
  const incomingIcon = typeof incoming.icon === 'string' ? incoming.icon : '';
  if (cur && curIcon.trim() !== '' && incomingIcon.trim() === '') {
    return { ...incoming, icon: cur.icon };
  }
  return incoming;
}

/** `level`纯L单调记忆（别名共享最大值，低不顶高，via正交）+ 图标M1内存缓冲已有实图记忆（`''` 守卫回退）。 */
const iconLevelById = new Map<string, number>();
const iconById = new Map<string, string>();

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
 * 唯一写入口：`icon-ready` 统一收口（M1内存唯一口，经 `getBufferedIcon` 回读）。
 * `level`纯L单调；`data:`/`via=m2`只进M1内存不落盘；M2首屏直填不走emit。
 * L5 显式徽章（`icon:'' + level:5`，用户切空意图）为唯一允许的空覆盖：
 * 清图标+level 记忆（cycle-back 可重接受 L2..L4）+ `invalidate` + `patch('')` + 读侧扇出；
 * 其余空图标一律丢弃（被动空壳保护）。
 * 时机：`invalidateIconCache` 先失效 → `preloadIcons` → `patch` 写透四列表 → 读侧扇出。
 */
/**
 * L5 显式徽章写（`applyHit` 内唯一空覆盖分支）：清图标+level 记忆
 * （`clearBufferedIcon` 同语义，cycle-back 可重接受 L2..L4，不复活旧图）、
 * `invalidate` AppIcon 内存、`patch('')` 写透、读侧扇出。无网络副作用。
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
    clearBufferedIcon(t);
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

/** 仅供测试：清空 `level`/图标记忆。 */
export function __resetIconStoreForTests(): void {
  iconLevelById.clear();
  iconById.clear();
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

/** L5 显式清零：用户手动切到空徽章时清掉该键缓冲（含 level 记忆），
 * 否则后续 `assemble/sticky` 经缓冲回读会复活旧图。`applyHit` 的 L5 分支
 * 经此做记忆清理（再补 `patch('')` + 读侧扇出）；直接调用方仅剩不需扇出的
 * 特殊路径，常规 L5 一律走 `applyHit({ icon:'', level:5 })`。 */
export function clearBufferedIcon(key: string): void {
  const k = normalizeId(key);
  if (!k) return;
  iconById.delete(k);
  iconLevelById.delete(k);
}

/**
 * 四列表写透补丁工厂（`applyHit.patch` 注入用，App 侧 `setApps/setOnlineApps/
 * setRecentlyViewedApps/setFavoriteExtraApps` 四件套）：
 * 返回 `(targetIdLower, icon) => void`，内部分发 `patchAppIconList` 写透四列表，
 * 单列表失败不阻塞其余。与 `App.tsx` 现内联四连 `patch` 同语义，收敛至此一处，
 * 调用方可渐进替换（C1 只提供工厂，不改 `App.tsx` 壳）。
 */
export function createFourListPatch(setters: {
  setApps: (f: (prev: AppSummary[]) => AppSummary[]) => void;
  setOnlineApps: (f: (prev: AppSummary[]) => AppSummary[]) => void;
  setRecentlyViewedApps: (f: (prev: AppSummary[]) => AppSummary[]) => void;
  setFavoriteExtraApps: (f: (prev: AppSummary[]) => AppSummary[]) => void;
}): (targetIdLower: string, icon: string) => void {
  return (targetIdLower: string, icon: string) => {
    try {
      setters.setApps((prev) => patchAppIconList(prev, targetIdLower, icon));
    } catch {
      // 单列表失败不阻塞其余
    }
    try {
      setters.setOnlineApps((prev) => patchAppIconList(prev, targetIdLower, icon));
    } catch {
      // 同上
    }
    try {
      setters.setRecentlyViewedApps((prev) => patchAppIconList(prev, targetIdLower, icon));
    } catch {
      // 同上
    }
    try {
      setters.setFavoriteExtraApps((prev) => patchAppIconList(prev, targetIdLower, icon));
    } catch {
      // 同上
    }
  };
}
