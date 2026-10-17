import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppDetail, AppSummary } from '../types';
import type { AppIconCycleResult } from '../services/api';
import { tauriApi } from '../services/api';
import { MANUAL_ONLY_NETWORK } from '../lib/manualOnly';
import { admitIconHit, patchAppIconList } from '../services/iconStore';
import { appSummaryFromDetail } from '../services/trends/enrich';
import { isRemoteIcon } from '../components/AppIcon';
import { normalizeId } from '../services/normalizeId';

/**
 * 收藏未收录行 left-join 合成（数据层唯一口径，展示层只读标记）。
 *
 * 背景：`apps` 来自 `searchApps('')` 仅收录库；`FavoritesView` 按
 * `favoriteIds` 内连接过滤会丢未收录行（计数用全集 `favoriteIds.size`）。
 * 此处对 `favoriteIds ∖ apps` 合成占位 `AppSummary`，再进
 * `matchPlatformSetWithLoading`（平台三态逻辑不动：占位 `platforms: []`
 * 即 loading 恒可见，落定后走正常 Other 过滤）。
 *
 * - 归一大小写：join/去重一律经前端唯一口 `normalizeId`（`trim().toLowerCase()`），
 *   原始 id 保留原值供 `FavoritesView` 精确 `has` 命中（双键：原值 + 小写在调用方分别建索引）。
 * - 富卡优先（cache-first）：`getCachedAppDetailsBatch`（DB-only 全量回填）→
 *   记录 `is_cataloged` 打标（`get_favorite_entries` + `get_watched_apps` 联合记录，
 *   任一显式 `false` 即未收录，缺字段旧快照默认已收录）；`None`/失败才用最小占位，
 *   保证行必展示。
 * - 标记：记录优先——记录已收录行 `is_cataloged: true`（已收录徽标 + 真实分类），
 *   记录未收录/缺席行 `is_cataloged: false` + 空分类兜底 external，供展示层
 *   `isAppCataloged` 打标用，不参与 join/过滤/计数；目录 `apps` 列表仅作结构
 *   去重/驱逐补充，永不覆盖记录标记。
 *
 * 深 join 模块：未收录 join（`(favorite∪watched)∖精选收录库`）唯一深模块，
 * 两种行为——exact（规范键精确查：归一精确差集 + 收录段合并去重）vs heuristic
 * （外部启发式：`parseFavoriteOwnerRepo` 末两段推导 + 占位合成行展示兜底）；
 * effect 侧 `useUncatalogedJoin` 收归于此，
 * 合并器收归 `app/selectors`（调用方经 `selectFavoritesViewApps` 消费）。
 * 行消失（收录到达驱逐/取消收藏）与计数保留（全集计数）语义不变，见删除测试。
 *
 * 键归一律经 `normalizeId` 单口（含 Set 口径 `normalizeIdLowerSet`）；`parseFavoriteOwnerRepo`
 * 为展示用启发式（保留原大小写，仅 trim），非 canonical，不经归一。
 */

export const FAVORITE_EXTERNAL_CATEGORY = 'external';
export const FAVORITE_EXTERNAL_CATEGORY_NAME = '跨平台开源';

export function parseFavoriteOwnerRepo(id: string): { owner: string; repo: string } {
  const clean = typeof id === 'string' ? id.trim() : '';
  // 支持 `owner/repo`、`github.com/owner/repo`、`https://.../owner/repo`、`gh:owner/repo` 等直查形态；
  // 取末两段为 owner/repo，取不到则 repo 回落 id 本身（保证可搜索、可展示）。
  const noScheme = clean.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^(gh|github):/i, '');
  const parts = noScheme.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length >= 2) {
    const repo = parts[parts.length - 1].replace(/\.git$/i, '');
    const owner = parts[parts.length - 2];
    if (owner && repo) return { owner, repo };
  }
  if (parts.length === 1 && parts[0]) {
    return { owner: parts[0], repo: parts[0] };
  }
  return { owner: clean, repo: clean };
}

/** 最小占位行：无详情缓存/离线失败时仍保证收藏行必展示（loading 恒可见）。 */
export function makeFavoritePlaceholderSummary(favId: string, isCataloged = false): AppSummary {
  const id = typeof favId === 'string' ? favId.trim() : '';
  const { owner, repo } = parseFavoriteOwnerRepo(id);
  const name = repo || id;
  return markFavoriteRowByRecord(
    {
      id,
      name,
      description_en: '',
      owner,
      repo,
      icon: '',
      icon_bg: 'linear-gradient(135deg, #475569, #334155)',
      description: '',
      stars: 0,
      forks: 0,
      license: '',
      latest_version: '',
      category: FAVORITE_EXTERNAL_CATEGORY,
      category_name: FAVORITE_EXTERNAL_CATEGORY_NAME,
      is_verified: false,
      is_cataloged: false,
      forge: 'github',
      forge_host: 'github.com',
      homepage: null,
      platforms: [],
    },
    isCataloged,
  );
}

/**
 * 详情派生合成行：`detail_to_summary` 前端同构（`appSummaryFromDetail`），
 * 仅补收录标记（空分类兜底 external，`is_cataloged: false` 显式携带）。
 * 有实分类（如被隐藏规则滤掉的收录项）保留实值，不强制覆盖。
 */
export function favoriteSummaryFromDetail(detail: AppDetail): AppSummary {
  return markFavoriteUncatalogedRow(appSummaryFromDetail(detail));
}

/**
 * 未收录行标记（`favoriteSummaryFromDetail` 与缓存批量回填共用）：
 * 空分类兜底 external，`is_cataloged: false` 显式携带供展示层打标；
 * 有实分类保留实值，不参与 join/过滤/计数。
 */
export function markFavoriteUncatalogedRow(summary: AppSummary): AppSummary {
  const category = summary.category && summary.category.trim() !== ''
    ? summary.category
    : FAVORITE_EXTERNAL_CATEGORY;
  const categoryName = summary.category_name && summary.category_name.trim() !== ''
    ? summary.category_name
    : FAVORITE_EXTERNAL_CATEGORY_NAME;
  return {
    ...summary,
    category,
    category_name: categoryName,
    is_cataloged: false,
  };
}

/**
 * 按记录打标（记录驱动口；与强制未收录口 `markFavoriteUncatalogedRow` 及缓存命中
 * 构造口 `favoriteSummaryFromCached` 区分）：
 * - `isCataloged=true` → 显式 `is_cataloged: true`（已收录徽标 + 真实分类保留，
 *   分类原样不动）；
 * - `isCataloged=false` → 未收录标记（空分类兜底 external）。
 * 记录缺席时调用方按未收录计（`?? false`），目录 `apps` 列表仅作结构去重/驱逐
 * 补充，永不覆盖记录标记。
 */
export function markFavoriteRowByRecord(summary: AppSummary, isCataloged: boolean): AppSummary {
  if (isCataloged) return { ...summary, is_cataloged: true };
  return markFavoriteUncatalogedRow(summary);
}

/**
 * 缓存批量回填富卡行：后端 `get_cached_app_details_batch` 已做
 * `detail→summary` 投影（图标/平台/描述自带，零网络），此处按记录标记
 * （记录优先，缺席即未收录）。形状异常（无 id）由调用方跳过。
 */
export function favoriteSummaryFromCached(hit: AppSummary, isCataloged = false): AppSummary {
  return markFavoriteRowByRecord(hit, isCataloged);
}

/**
 * 记录收录标记表（归一小写键 → `is_cataloged`）：
 * 收藏记录 + 关注记录 union，任一显式 `false` 即未收录（false 优先于 stale 的
 * true）；记录缺字段（旧快照）默认已收录；非数组/脏行直接忽略（调用方 mock 缺席即空表）。
 */
export function buildRecordCatalogedMap(
  favEntries: ReadonlyArray<{ app_id?: unknown; is_cataloged?: unknown }> | unknown,
  watchEntries: ReadonlyArray<{ app_id?: unknown; is_cataloged?: unknown }> | unknown,
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  const lists = [favEntries, watchEntries];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e.app_id !== 'string') continue;
      const k = normalizeId(e.app_id);
      if (!k) continue;
      const flag = typeof e.is_cataloged === 'boolean' ? e.is_cataloged : true;
      map.set(k, map.has(k) ? (map.get(k) as boolean) && flag : flag);
    }
  }
  return map;
}

/**
 * 记录表示值读取：归一键缺席即未收录（`?? false`），调用方无需重复空值合并。
 */
export function isRecordCataloged(record: ReadonlyMap<string, boolean>, key: string): boolean {
  return record.get(key) ?? false;
}

/**
 * 占位行判定（视图手动加载按钮唯一依据，不参与 join/过滤/计数）：
 * 无描述/版本/图标且零星零叉的空壳行即占位（含记录已收录但缓存缺失的空壳）；
 * 富卡行（任一实质字段非空）返回 false。
 */
export function isFavoritePlaceholderRow(app: AppSummary): boolean {
  if (!app) return false;
  const emptyText = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';
  return (
    emptyText(app.description) &&
    emptyText(app.description_en) &&
    emptyText(app.latest_version) &&
    emptyText(app.icon) &&
    (app.stars ?? 0) === 0 &&
    (app.forks ?? 0) === 0
  );
}

/**
 * 收藏占位行图标热替口径（与搜索/最近同一套：店内 `admitIconHit` 唯一写口读 `app_icon_cycles`
 * 即前端侧 `resolve_confirmed_icon_from_db` 同源 + 后端 ensure/download 回填）。
 *
 * `pickFavoritePersistIconUrl`：轮换结果取可落盘持久化 URL——`remote_url` 优先，
 * `url` 非 `data:` 才兜底（`data:` 即时态永不进盘）；非远端置空走首字母
 *（`isRemoteIcon` 同规则）。
 */
export function pickFavoritePersistIconUrl(
  cycle: AppIconCycleResult | null | undefined,
): string {
  // 后端规范字段为 snake_case（`remote_url`），此处按需直读。
  const remote = (cycle?.remote_url ?? '').trim();
  const fallback = (cycle?.url ?? '').trim();
  const persist = remote !== '' ? remote : (!fallback.startsWith('data:') ? fallback : '');
  if(!persist||!isRemoteIcon(persist))return'';
  return persist;
}

/**
 * 摘要图标是否缺图标预热：空/非远端（首字母占位态）即需经店内写口查轮换回填；
 * 已有合法远端仅需店内写口做 M1 缓冲 + 文件预热（与搜索首屏预热同通道）。
 */
export function needsFavoriteIconWarm(icon: unknown): boolean {
  if (typeof icon !== 'string') return true;
  const value = icon.trim();
  if(!value||!isRemoteIcon(value))return true;
  return false;
}

/**
 * 求 `favoriteIds ∖ (catalog ∪ extra)`（大小写归一，按小写去重保序）。
 * 返回原始 favId（保留原大小写供展示层精确命中），调用方按小写建双键索引。
 * 键口径一律 `normalizeId` 单口。
 */
function findMissingIds(
  favoriteIds: Iterable<string>,
  catalogLower: ReadonlySet<string>,
  extraLower?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const raw of favoriteIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) continue;
    const key = normalizeId(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (catalogLower.has(key)) continue;
    if (extraLower?.has(key)) continue;
    missing.push(id);
  }
  return missing;
}

export interface UseUncatalogedJoinParams {
  favoriteIds: Set<string>;
  watchedIds: Set<string>;
  apps: AppSummary[];
}

/**
 * 收藏/关注 left-join 富卡行（cache-first，记录优先打标）。
 *
 * 顺序：(a) `missing` 同步占位行（行必展示）；(b) `get_cached_app_details_batch`
 * 对全部 fav/watch id 批量回填富卡数据（DB-only 本地读）；(c) 逐行按记录
 * `is_cataloged` 打标——记录优先，目录 `apps` 列表仅作结构去重/驱逐补充，
 * 永不覆盖记录标记。
 * 记录已收录行得已收录徽标 + 真实分类；记录未收录/缺席行得未收录徽标；
 * `None` 行保持占位，经行内加载按钮（`loadUncatalogedDetail`）或详情打开
 * 手动拉取。归一大小写 + 双键；占位行 `platforms: []` 即 loading，
 * 平台三态/徽标逻辑一律不动。失败即最小占位，行必展示；收录到达即驱逐。
 * 资产区默认 DB-only：占位 + 缓存富卡自动呈现，`getAppDetails`/
 * `restoreOrFetchIconCycle` 仅手动触发。
 */
export function useUncatalogedJoin({ favoriteIds, watchedIds, apps }: UseUncatalogedJoinParams) {
  // 收藏/关注未收录富卡行 left-join：`(favoriteIds∪watchedIds)` 先占位，
  // 再经 `getCachedAppDetailsBatch`（DB-only）回填富卡 + 记录表打标，仅收藏页消费，
  // 不进 `apps`/计数/其它视图；`platforms: []` 即 loading 恒可见，平台三态不动）。
  // 占位行经缓存批量升级；`None` 行留待行内加载按钮或详情打开手动拉取。
  const [favoriteExtraApps, setFavoriteExtraApps] = useState<AppSummary[]>([]);
  const favoriteExtraAppsRef = useRef<AppSummary[]>([]);
  favoriteExtraAppsRef.current = favoriteExtraApps;
  const favoriteExtraInflightRef = useRef<Set<string>>(new Set());
  // 记录收录标记表（归一小写键 → is_cataloged，行打标唯一依据；目录 apps 仅补充去重）。
  const recordCatalogedRef = useRef<Map<string, boolean>>(new Map());

  // Per-row manual loader: explicit Load info for one uncataloged id (detail + icon cycle).
  const loadUncatalogedDetail = useCallback(async (favId: string): Promise<void> => {
    const raw = typeof favId === 'string' ? favId.trim() : '';
    if (!raw) return;
    const key = normalizeId(raw);
    if (!key || favoriteExtraInflightRef.current.has(key)) return;
    favoriteExtraInflightRef.current.add(key);
    try {
      let summary: AppSummary;
      try {
        const detail = await tauriApi.getAppDetails(raw);
        summary = favoriteSummaryFromDetail(detail);
      } catch {
        summary = makeFavoritePlaceholderSummary(raw);
      }
      // 手动拉取行同样按记录打标（记录缺席即未收录）。
      summary = markFavoriteRowByRecord(summary, isRecordCataloged(recordCatalogedRef.current, key));
      const k = normalizeId(summary.id);
      if (k) {
        setFavoriteExtraApps((prev) => {
          for (const e of prev) {
            if (normalizeId(e.id) === k) return prev;
          }
          return [...prev, summary];
        });
      }
      try {
        const currentIcon = (summary.icon || '').trim();
        if (!needsFavoriteIconWarm(currentIcon)) {
          admitIconHit({ id: summary.id, icon: currentIcon });
          return;
        }
        const cycle = await tauriApi.restoreOrFetchIconCycle(raw);
        const persistUrl = pickFavoritePersistIconUrl(cycle);
        const cycleLevel = typeof cycle?.level === 'number' ? cycle.level : undefined;
        if (!persistUrl) {
          if (cycleLevel === 5) {
            admitIconHit({
              id: summary.id,
              icon: '',
              level: 5,
              patch: (tid, icon) => {
                setFavoriteExtraApps((prev) => patchAppIconList(prev, tid, icon));
              },
            });
          }
          return;
        }
        admitIconHit({
          id: summary.id,
          icon: persistUrl,
          level: cycleLevel,
          patch: (tid, icon) => {
            setFavoriteExtraApps((prev) => patchAppIconList(prev, tid, icon));
          },
        });
      } catch {
        // 取不到轮换图标则保持占位，不阻塞
      }
    } finally {
      favoriteExtraInflightRef.current.delete(key);
    }
  }, []);

  useEffect(() => {
    if (favoriteIds.size === 0 && watchedIds.size === 0) {
      if (favoriteExtraAppsRef.current.length > 0) setFavoriteExtraApps([]);
      recordCatalogedRef.current = new Map();
      return;
    }
    const catalogLower = new Set<string>();
    for (const a of apps) {
      const k = normalizeId(a.id);
      if (k) catalogLower.add(k);
    }
    const current = favoriteExtraAppsRef.current;
    // 收录到达即驱逐（大小写归一），避免与目录行双显
    let pruned: AppSummary[] | null = null;
    if (current.length > 0 && catalogLower.size > 0) {
      pruned = current.filter((e) => !catalogLower.has(normalizeId(e.id)));
      if (pruned.length !== current.length) setFavoriteExtraApps(pruned);
    }
    const baseLower = pruned ?? current;
    const baseLowerSet = new Set<string>();
    for (const e of baseLower) {
      const k = normalizeId(e.id);
      if (k) baseLowerSet.add(k);
    }
    // 收藏+关注 union 求缺：任一集合未收录即合成（共用同一占位 helpers/去重/inflight 口径）。
    const unionIds = new Set<string>([...favoriteIds, ...watchedIds]);
    const missing = findMissingIds(unionIds, catalogLower, baseLowerSet).filter(
      (id) => !favoriteExtraInflightRef.current.has(normalizeId(id)),
    );
    if (missing.length === 0 && favoriteExtraAppsRef.current.length === 0) return;
    let cancelled = false;
    // (a) 占位行同步（行必展示；打标用上轮记录表，重合后由 (c) 按最新记录纠正）。
    if (missing.length > 0) {
      const knownRecords = recordCatalogedRef.current;
      setFavoriteExtraApps((prev) => {
        const seen = new Set(prev.map((e) => normalizeId(e.id)));
        const toAdd: AppSummary[] = [];
        for (const id of missing) {
          const k = normalizeId(id);
          if (!k || seen.has(k) || catalogLower.has(k)) continue;
          seen.add(k);
          toAdd.push(makeFavoritePlaceholderSummary(id, knownRecords.get(k) ?? false));
        }
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
    }
    // (b) 富卡数据批量回填（全部 fav/watch id，DB-only 本地读，不经网络门控）与
    // (c) 记录表并行拉取；单次合并中先按最新记录重打标既有行，再合入富卡行。
    // 目录 apps 列表仅作结构去重/驱逐（catalogLower），永不覆盖记录标记。
    const seenAll = new Set<string>();
    const allIds: string[] = [];
    for (const raw of unionIds) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      const k = normalizeId(id);
      if (!k || seenAll.has(k)) continue;
      seenAll.add(k);
      allIds.push(id);
    }
    void Promise.all([
      (allIds.length > 0 ? tauriApi.getCachedAppDetailsBatch(allIds) : Promise.resolve([])).catch(() => null),
      tauriApi.getFavoriteEntries().catch(() => []),
      tauriApi.getWatchedApps().catch(() => []),
    ]).then(([rows, favEntries, watchEntries]) => {
      if (cancelled) return;
      const record = buildRecordCatalogedMap(favEntries, watchEntries);
      recordCatalogedRef.current = record;
      const hits = Array.isArray(rows) ? rows : [];
      const rich: AppSummary[] = [];
      for (const hit of hits) {
        if (!hit) continue;
        const k = normalizeId(hit.id);
        if (!k) continue;
        rich.push(markFavoriteRowByRecord(hit, record.get(k) ?? false));
      }
      setFavoriteExtraApps((prev) => {
        if (prev.length === 0 && rich.length === 0) return prev;
        const next = [...prev];
        const indexByKey = new Map<string, number>();
        next.forEach((e, i) => {
          const k = normalizeId(e.id);
          if (k && !indexByKey.has(k)) indexByKey.set(k, i);
        });
        let changed = false;
        // (c1) 既有行按最新记录重打标（徽标跟记录走；记录缺席的行保持原样）。
        next.forEach((e, i) => {
          const k = normalizeId(e.id);
          const flag = k ? record.get(k) : undefined;
          if (flag === undefined || e.is_cataloged === flag) return;
          next[i] = markFavoriteRowByRecord(e, flag);
          changed = true;
        });
        // (c2) 富卡行合入：目录已收录键跳过（由目录行渲染，避免双显）。
        for (const r of rich) {
          const k = normalizeId(r.id);
          if (!k || catalogLower.has(k)) continue;
          const at = indexByKey.get(k);
          if (at === undefined) {
            indexByKey.set(k, next.length);
            next.push(r);
            changed = true;
          } else if (next[at] !== r) {
            next[at] = r;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }).catch(() => {});
    // 资产区默认 DB-only：占位 + 缓存富卡自动呈现，详情/图标轮换仅行内按钮或详情打开手动触发。
    if (MANUAL_ONLY_NETWORK) {
      return () => {
        cancelled = true;
      };
    }
    for (const id of missing) favoriteExtraInflightRef.current.add(normalizeId(id));
    void (async () => {
      try {
        // 并发拉取、逐个落地：避免串行 6 倍等待；单个落盘经函数式去重，首个原值保留。
        // 图标先占位后热替（不阻塞首屏）：落盘后经 `restoreOrFetchIconCycle`（前端侧
        // `resolve_confirmed_icon_from_db` 同源读 `app_icon_cycles` + 后端回填）
        // 查轮换，命中即 `setFavoriteExtraApps` 逐个热替；已有合法远端仅文件预热。
        await Promise.all(
          missing.map(async (favId) => {
            let summary: AppSummary;
            try {
              const detail = await tauriApi.getAppDetails(favId);
              summary = favoriteSummaryFromDetail(detail);
            } catch {
              summary = makeFavoritePlaceholderSummary(favId);
            }
            if (cancelled) return;
            const k = normalizeId(summary.id);
            if (!k) return;
            // 非 manual 兜底分支同样按记录打标（记录缺席即未收录）。
            summary = markFavoriteRowByRecord(summary, isRecordCataloged(recordCatalogedRef.current, k));
            // 若期间收录到达则跳过（由驱逐逻辑收敛，不双显）
            if (catalogLower.has(k)) return;
            setFavoriteExtraApps((prev) => {
              const lower = k;
              for (const e of prev) {
                if (normalizeId(e.id) === lower) return prev;
              }
              return [...prev, summary];
            });
            void (async () => {
              try {
                const currentIcon = (summary.icon || '').trim();
                if (!needsFavoriteIconWarm(currentIcon)) {
                  // 详情已带合法远端：经店内唯一写口做 M1 缓冲 + 文件预热（与搜索同通道，不直调 IPC）。
                  admitIconHit({ id: summary.id, icon: currentIcon });
                  return;
                }
                // 无可用远端：查轮换（同步读库命中即返，无则后端补探回填），命中经店内写口热替占位行。
                // L5 显式徽章（cycle.level===5）经唯一写口扇出占位行跟进；取不到轮换则保持占位。
                const cycle = await tauriApi.restoreOrFetchIconCycle(favId);
                const persistUrl = pickFavoritePersistIconUrl(cycle);
                const cycleLevel = typeof cycle?.level === 'number' ? cycle.level : undefined;
                if (!persistUrl) {
                  if (cycleLevel === 5 && !cancelled) {
                    admitIconHit({
                      id: summary.id,
                      icon: '',
                      level: 5,
                      patch: (tid, icon) => {
                        setFavoriteExtraApps((prev) => patchAppIconList(prev, tid, icon));
                      },
                    });
                  }
                  return;
                }
                if (cancelled) return;
                admitIconHit({
                  id: summary.id,
                  icon: persistUrl,
                  level: cycleLevel,
                  patch: (tid, icon) => {
                    setFavoriteExtraApps((prev) => patchAppIconList(prev, tid, icon));
                  },
                });
              } catch {
                // 取不到轮换图标则保持占位，不阻塞
              }
            })();
          }),
        );
      } finally {
        // 取消/完成均注销 inflight，避免泄漏导致后续 missing=0 自锁
        for (const id of missing) favoriteExtraInflightRef.current.delete(normalizeId(id));
      }
    })();
    return () => {
      cancelled = true;
      // 同步注销本轮 inflight，保证 apps 到达后的下一轮能重算 missing
      for (const id of missing) favoriteExtraInflightRef.current.delete(normalizeId(id));
    };
  }, [favoriteIds, watchedIds, apps]);

  return {
    favoriteExtraApps,
    setFavoriteExtraApps,
    favoriteExtraAppsRef,
    loadUncatalogedDetail,
  };
}
