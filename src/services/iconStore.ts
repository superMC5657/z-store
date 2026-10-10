/** 前端图标唯一写入口。
 * level纯L单调（via正交）；M1=内存（iconStore/searchListCache/enrich经getBufferedIcon/applyHit唯一口）；
 * M2=DB（via=m2首屏直填，不走emit）。
 */
import { invalidateIconCache, isAvatarUrl, preloadIcons } from '../components/AppIcon';
import type { AppSummary } from '../types';
import { normalizeId, normalizeIdSet } from './normalizeId';

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
    if (a.id.toLowerCase() === targetIdLower) {
      if (a.icon === icon) return a;
      changed = true;
      return { ...a, icon };
    }
    return a;
  });
  return changed ? next : prev;
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

/** 命中携带的门控：`search_id` 取 `context` 回落顶层，`board`/`gen` 取 `context`。 */
function resolveIncomingGate(args: ApplyHitArgs): GenerationGate {
  const ctx = args.context ?? null;
  const search_id =
    ctx && typeof ctx.search_id === 'string' && ctx.search_id
      ? ctx.search_id
      : typeof args.search_id === 'string'
        ? args.search_id
        : '';
  const board = ctx && typeof ctx.board === 'string' ? ctx.board : '';
  const gen =
    ctx && typeof ctx.gen === 'number' && Number.isFinite(ctx.gen) ? ctx.gen : undefined;
  return { search_id, board, gen };
}

/** 当前态期望门控：搜索 id 即时取值，榜单世代经取值函数回落静态值。 */
function resolveExpectedGate(args: ApplyHitArgs, incomingBoard: string): GenerationGate {
  let gen: number | undefined;
  try {
    if (typeof args.getBoardGen === 'function') {
      const key = normalizeId(args.board) || normalizeId(incomingBoard) || undefined;
      const v = args.getBoardGen(key);
      if (typeof v === 'number' && Number.isFinite(v)) gen = v;
    }
  } catch {
    // 取值失败按空处理（放行）
  }
  if (
    gen === undefined &&
    typeof args.boardGen === 'number' &&
    Number.isFinite(args.boardGen)
  ) {
    gen = args.boardGen;
  }
  return {
    search_id: resolveCurrentSearchId(args),
    board: typeof args.board === 'string' ? args.board : '',
    gen,
  };
}

/**
 * 唯一过期判断：返回丢弃原因，放行返回 `undefined`。
 * `kind` 缺省按搜索走扁平 `search_id`；未知 `kind` 直接放行。
 * 搜索门任一空即放行：回声窗内期望空，首刷直播按回声 sid 收；
 * 期望立定后双非空不等才判 `stale-search-id`（旧串号丢）。
 */
function gateStaleReason(
  kind: string,
  incoming: GenerationGate,
  expected: GenerationGate,
): string | undefined {
  if (kind === '' || kind === 'search') {
    const a = typeof incoming.search_id === 'string' ? incoming.search_id : '';
    const b = typeof expected.search_id === 'string' ? expected.search_id : '';
    if (a && b && a !== b) return 'stale-search-id';
    return undefined;
  }
  if (kind === 'trend') {
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
  return undefined;
}

/**
 * 唯一写入口：`icon-ready` 统一收口（M1内存唯一口，经 `getBufferedIcon` 回读）。
 * `level`纯L单调；`data:`/`via=m2`只进M1内存不落盘；M2首屏直填不走emit。
 * 时机：`invalidateIconCache` 先失效 → `preloadIcons` → `patch` 写透四列表。
 */
export function applyHit(args: ApplyHitArgs): ApplyHitResult {
  if (!args || typeof args !== 'object') return { accepted: false, reason: 'empty-hit' };

  const targets = resolveIconTargets(args);
  if (targets.length === 0) return { accepted: false, reason: 'missing-target' };

  const rawIcon = typeof args.icon === 'string' ? args.icon.trim() : '';
  // `''` 永不覆盖已有实图；无实图时亦为无操作，直接丢弃。
  if (rawIcon === '') {
    const keep = hasExistingRealIcon(targets, args.getCurrentIcon);
    return { accepted: false, targets, reason: keep ? 'empty-keeps-real' : 'empty-noop' };
  }
  const icon = rawIcon;
  // 写透守卫：avatar 一律丢弃（不推进 `level` 记忆）。
  if (isAvatarUrl(icon)) return { accepted: false, targets, icon, reason: 'avatar-dropped' };

  // 世代门控：过期判断只此一处（搜索走 `search_id`，榜单走 `board`+`gen`）。
  const ctx = args.context ?? null;
  const kind = ctx && typeof ctx.kind === 'string' ? ctx.kind.trim().toLowerCase() : '';
  const incoming = resolveIncomingGate(args);
  const expected = resolveExpectedGate(args, typeof incoming.board === 'string' ? incoming.board : '');
  const stale = gateStaleReason(kind, incoming, expected);
  if (stale) return { accepted: false, targets, icon, reason: stale };

  // `level`纯L单调升级：低不顶高，via正交不参与比较（live L2/L3 不因 via 丢）。缺省即放行且不推进记忆。
  const level =
    typeof args.level === 'number' && Number.isFinite(args.level) ? args.level : undefined;
  if (level !== undefined) {
    let currentMax: number | undefined;
    for (const t of targets) {
      const s = iconLevelById.get(t);
      if (s !== undefined && (currentMax === undefined || s > currentMax)) currentMax = s;
    }
    if (currentMax !== undefined && level < currentMax) {
      return { accepted: false, targets, icon, level, reason: 'level-stale' };
    }
    const next = currentMax === undefined ? level : Math.max(currentMax, level);
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
    return {
      accepted: true,
      targets,
      icon,
      level,
      persisted: false,
      reason: icon.startsWith('data:') ? 'data-memory-only' : 'm2-memory-only',
    };
  }

  // 仅 `remote(http)` 才 `patch state + preloadIcons` 走 `get_or_fetch_icon` 落盘。
  if (!isRemoteHttpIconUrl(icon)) {
    return { accepted: false, targets, icon, level, reason: 'non-remote-dropped' };
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
  return { accepted: true, targets, icon, level, persisted: true };
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
