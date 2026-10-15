import { useEffect, useRef, useState } from 'react';
import type { AppDetail, AppSummary } from '../types';
import type { AppIconCycleResult } from '../services/api';
import { tauriApi } from '../services/api';
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
 * `matchPlatformSetWithPending`（平台三态逻辑不动：占位 `platforms: []`
 * 即 pending 恒可见，落定后走正常 Other 过滤）。
 *
 * - 归一大小写：join/去重一律经前端唯一口 `normalizeId`（`trim().toLowerCase()`），
 *   原始 id 保留原值供 `FavoritesView` 精确 `has` 命中（双键：原值 + 小写在调用方分别建索引）。
 * - 详情优先：`tauriApi.getAppDetails(id)`（后端经 `get_cached_app_detail_fallback`
 *   回退，TTL 外/离线仍可显）→ `appSummaryFromDetail`（`detail_to_summary`
 *   前端同构）；失败才用最小占位，保证行必展示。
 * - 标记：合成行一律 `is_cataloged: false` + `category: 'external'`
 *  （有详情实分类则保留实值，仅空时兜底 external），供展示层
 *   `isAppCataloged` 打标用，不参与 join/过滤/计数。
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

/** 最小占位行：无详情缓存/离线失败时仍保证收藏行必展示（pending 恒可见）。 */
export function makeFavoritePlaceholderSummary(favId: string): AppSummary {
  const id = typeof favId === 'string' ? favId.trim() : '';
  const { owner, repo } = parseFavoriteOwnerRepo(id);
  const name = repo || id;
  return {
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
  };
}

/**
 * 详情派生合成行：`detail_to_summary` 前端同构（`appSummaryFromDetail`），
 * 仅补收录标记（空分类兜底 external，`is_cataloged: false` 显式携带）。
 * 有实分类（如被隐藏规则滤掉的收录项）保留实值，不强制覆盖。
 */
export function favoriteSummaryFromDetail(detail: AppDetail): AppSummary {
  const summary = appSummaryFromDetail(detail);
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
 * 收藏/关注 left-join 占位行。
 *
 * `(favoriteIds∪watchedIds) ∖ apps` 经 `getAppDetails`（后端
 * `get_cached_app_detail_fallback` 回退）合成占位行，未收录也能展示。
 * 归一大小写 + 双键；合成行 `is_cataloged=false/category=external`，
 * `platforms: []` 即 pending，平台三态/徽标逻辑一律不动。
 * 失败即最小占位，行必展示；收录到达即驱逐。
 */
export function useUncatalogedJoin({ favoriteIds, watchedIds, apps }: UseUncatalogedJoinParams) {
  // 收藏/关注未收录占位行 left-join：`(favoriteIds∪watchedIds) ∖ apps` 经详情回退合成，仅收藏页消费，
  // 不进 `apps`/计数/其它视图；`platforms: []` 即 pending 恒可见，平台三态不动）。
  const [favoriteExtraApps, setFavoriteExtraApps] = useState<AppSummary[]>([]);
  const favoriteExtraAppsRef = useRef<AppSummary[]>([]);
  favoriteExtraAppsRef.current = favoriteExtraApps;
  const favoriteExtraInflightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (favoriteIds.size === 0 && watchedIds.size === 0) {
      if (favoriteExtraAppsRef.current.length > 0) setFavoriteExtraApps([]);
      return;
    }
    const catalogLower = new Set<string>();
    for (const a of apps) {
      const k = normalizeId(a.id);
      if (k) catalogLower.add(k);
    }
    const current = favoriteExtraAppsRef.current;
    const currentLower = new Set<string>();
    for (const e of current) {
      const k = normalizeId(e.id);
      if (k) currentLower.add(k);
    }
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
    if (missing.length === 0) return;
    for (const id of missing) favoriteExtraInflightRef.current.add(normalizeId(id));
    let cancelled = false;
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
  };
}
