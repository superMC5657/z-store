/**
 * P1 统一图标方案：前端唯一写入口（只做前端，不碰 `src-tauri`）。
 * P2 趋势流式化：Trend 接 `board_gen` 门控（与 Search `search_id` 门控同构，
 * 任一为空即放行、双非空不等即丢弃；后端 `BOARD_GEN` 落库前+emit前双检查独立防串，
 * 前端只看 `board` 字符串，`gen` 透传比对当双方均提供时才生效）。
 *
 * 后端 P0 双发旧 `zstore://search-icon-ready{search_id,app_id,icon,level}` +
 * 新 `zstore://icon-ready{key,id,icon,level,context{kind,search_id?,board?,gen?}}`
 *（`key`=小写 `owner/repo`，`level`: 2=simple / 3=trees / 4=confirmed）。
 * 本模块是前端唯一的图标写透收口，唯一写入口 {@link applyHit}：
 *  1. 归一 key+id 别名双写（`trendEnrichKey` 小写 + `AppIcon:appIdToIconMap`
 *     双写语义：原值与小写各记一键，此处统一归一小写去重后逐别名写透）。
 *  2. 世代门控：Search 看 `search_id===currentSearchId`（与 `App.tsx` 旧语义一致：
 *     双非空且不等即丢弃）；Trend 看 `board===activeBoard` + 可选 `gen` 透传比对
 *    （`board/boardGen/getBoardGen`，P2 接线；任一为空即放行，首屏兼容）。
 *  3. 写透守卫：avatar 丢弃、`data:` 只进内存不落盘、`''` 不覆盖已有实图、
 *     `level` 单调升级（低不顶高）。
 *  4. 仅 `remote(http)` 才 `patch state + preloadIcons([{id,icon}])`
 *     走 `get_or_fetch_icon` 落盘；`data:` 只 patch 内存态不 preload。
 *
 * 调用方（`App.tsx` 搜索回调只传 `search_id` 门控；`TrendsView` 趋势回调只传
 * `board` 门控）只做新旧载荷适配 + React 列表 `patch` 注入，
 * `invalidateIconCache` 先失效再 `preload` 的时机由店内保证。
 */
import { invalidateIconCache, isAvatarUrl, preloadIcons } from '../components/AppIcon';
import type { AppSummary } from '../types';

/** 新统一事件上下文（后端 `icon_fetch::IconFetchCtx` 的前端镜像）。 */
export interface IconHitContext {
  kind: 'search' | 'trend' | string;
  search_id?: string;
  board?: string;
  gen?: number;
}

/** 新旧双事件的并集命中（新字段 + 旧 `search-icon-ready` 兼容字段）。 */
export interface IconHit {
  /** 新事件 `key`（小写 `owner/repo`）。 */
  key?: string | null;
  /** 新事件 `id`（小写 `owner/repo`，与旧 `app_id` 同值）。 */
  id?: string | null;
  /** 旧事件兼容：`search-icon-ready.app_id`。 */
  app_id?: string | null;
  icon?: string | null;
  level?: number | null;
  context?: IconHitContext | null;
  /** 旧事件兼容：顶层 `search_id`（新事件走 `context.search_id`）。 */
  search_id?: string | null;
}

/** 新统一事件载荷（`zstore://icon-ready`，供 `catalog.ts` 订阅打型）。 */
export interface IconReadyPayload {
  key: string;
  id: string;
  icon: string;
  level: number;
  context: IconHitContext;
}

export interface ApplyHitArgs extends IconHit {
  /**
   * Search 世代门控：当前搜索 id（字符串或取值函数，与
   * `useSearchState.currentSearchIdRef.current` 同源）。
   * 双非空且与命中 `search_id` 不等即丢弃；任一为空即放行（首屏兼容）。
   */
  currentSearchId?: string | (() => string | undefined) | null;
  getCurrentSearchId?: () => string | undefined;
  /**
   * Trend 门控（P2 接线，切榜防串，与 Search `search_id` 门控同构）：
   * 榜单 id / 榜单世代 / 取榜单世代函数。任一为空即放行（首屏兼容，
   * 后端 `board=""` 未传板名时前端放行，后端 `BOARD_GEN` 双检查独立防串）；
   * 双非空且不等即丢弃（切榜后旧榜在途图标不再 patch 新榜）。
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
  /** `true`=走了 `preloadIcons→get_or_fetch_icon` 落盘；`false`=`data:` 纯内存。 */
  persisted?: boolean;
  reason?: string;
}

/**
 * 单图标升级时仅替换对应 id 的对象，其余复用原引用；
 * 若目标不存在或图标已一致则直接返回原数组引用，避免全网格重渲染闪烁。
 *（唯一实现处：`App.tsx` 经此处重导出，测试沿 `../App` 导入不动。）
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
 * 归一 key+id 别名（`enrich.ts:trendEnrichKey` + `AppIcon:appIdToIconMap` 口径）：
 * 取 `key/id/app_id` 去空 → `trim().toLowerCase()` → 去重。
 */
export function resolveIconTargets(hit: Pick<IconHit, 'key' | 'id' | 'app_id'>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const raws: unknown[] = [hit?.key, hit?.id, hit?.app_id];
  for (const raw of raws) {
    if (typeof raw !== 'string') continue;
    const k = raw.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
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

/** `level` 单调记忆（别名共享最大值，低不顶高）+ 已有实图记忆（`''` 守卫回退）。 */
const iconLevelById = new Map<string, number>();
const iconById = new Map<string, string>();

function resolveCurrentSearchId(args: ApplyHitArgs): string {
  try {
    if (typeof args.getCurrentSearchId === 'function') {
      const v = args.getCurrentSearchId();
      if (typeof v === 'string' && v) return v;
    }
  } catch {
    // 取值失败按空处理（放行，首屏兼容）
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
 * 唯一写入口：新旧双事件统一收口。
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

  // 世代门控：P1 只接 Search。`kind` 缺省（旧事件无 context）按 Search 走扁平 `search_id`。
  const ctx = args.context ?? null;
  const kind = ctx && typeof ctx.kind === 'string' ? ctx.kind.trim().toLowerCase() : '';
  if (kind === '' || kind === 'search') {
    const incomingSearchId =
      ctx && typeof ctx.search_id === 'string' && ctx.search_id
        ? ctx.search_id
        : typeof args.search_id === 'string'
          ? args.search_id
          : '';
    const current = resolveCurrentSearchId(args);
    if (incomingSearchId && current && incomingSearchId !== current) {
      return { accepted: false, targets, icon, reason: 'stale-search-id' };
    }
  } else if (kind === 'trend') {
    // P2 趋势门控：`board` 字符串为主（与搜索 `search_id` 同构，双非空不等即丢弃，
    // 任一为空即放行——后端未传板名 `board=""` 时前端放行，后端 `BOARD_GEN` 双检查独立防串）；
    // `gen` 透传比对仅当双方均提供数字时才生效（前端当前只传 `board` 字符串，
    // `boardGen/getBoardGen` 缺省即放行，首屏兼容）。
    const incomingBoard =
      ctx && typeof ctx.board === 'string' ? ctx.board.trim().toLowerCase() : '';
    const expectedBoard =
      typeof args.board === 'string' ? args.board.trim().toLowerCase() : '';
    if (incomingBoard && expectedBoard && incomingBoard !== expectedBoard) {
      return { accepted: false, targets, icon, reason: 'stale-board' };
    }
    let expectedGen: number | undefined;
    try {
      if (typeof args.getBoardGen === 'function') {
        const v = args.getBoardGen(expectedBoard || incomingBoard || undefined);
        if (typeof v === 'number' && Number.isFinite(v)) expectedGen = v;
      }
    } catch {
      // 取值失败按空处理（放行，首屏兼容）
    }
    if (
      expectedGen === undefined &&
      typeof args.boardGen === 'number' &&
      Number.isFinite(args.boardGen)
    ) {
      expectedGen = args.boardGen;
    }
    const incomingGen =
      ctx && typeof ctx.gen === 'number' && Number.isFinite(ctx.gen) ? ctx.gen : undefined;
    if (incomingGen !== undefined && expectedGen !== undefined && incomingGen !== expectedGen) {
      return { accepted: false, targets, icon, level: undefined, reason: 'stale-board-gen' };
    }
  }

  // `level` 单调升级：低不顶高。缺省（旧兼容）即放行且不推进记忆。
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

  // `data:` 只进内存不落盘：失效 + patch 内存态，跳过 `preloadIcons`（其本身亦跳 `data:`，此处显式保证）。
  if (icon.startsWith('data:')) {
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
    return { accepted: true, targets, icon, level, persisted: false, reason: 'data-memory-only' };
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
 * P2 趋势流式缓冲读口：`icon-ready` 先到、`enrich` 后到竞态时，
 * `enrich` 组装（service `enrichTrendRepos` + `TrendsView` 合并）经此取缓冲实图，
 * 空壳不覆盖缓冲实图（无空覆实；`avatar` 永不进缓冲由 `applyHit` 保证，
 * 此处再判空串即可）。
 */
export function getBufferedIcon(key: string): string | undefined {
  if (typeof key !== 'string') return undefined;
  const k = key.trim().toLowerCase();
  if (!k) return undefined;
  const v = iconById.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 仅供测试：读取别名已记忆 `level`。 */
export function __getIconStoreLevel(id: string): number | undefined {
  if (typeof id !== 'string') return undefined;
  return iconLevelById.get(id.trim().toLowerCase());
}
