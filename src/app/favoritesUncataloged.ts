import { useCallback, useEffect, useRef } from 'react';
import type { AppDetail, AppSummary } from '../types';
import { tauriApi } from '../services/api';
import { admitIconCycleResult, admitIconHit, patchAppIconList } from '../services/iconStore';
import { appSummaryFromDetail } from '../services/repoEnrichCache';
import { isRemoteIcon } from '../components/AppIcon';
import { normalizeId, normalizeIdLowerSet } from '../services/normalizeId';
import { isCatalogedFailClosed } from '../utils/appHelper';
import { annotateLocalSource, buildCatalogIdSet } from './selectors';
import { DEFAULT_ICON_BG } from '../styles/tokens';

/**
 * 收藏/关注未收录行的 left-join 合成：为不在收录库中的条目生成占位或缓存富卡，
 * 并依据记录表的 `is_cataloged` 打标，供收藏页展示。
 */

const FAVORITE_EXTERNAL_CATEGORY = 'external';
const FAVORITE_EXTERNAL_CATEGORY_NAME = '跨平台开源';

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
      icon_bg: DEFAULT_ICON_BG,
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

/** 从详情构造带未收录标记的摘要，空分类回落至 external。 */
export function favoriteSummaryFromDetail(detail: AppDetail): AppSummary {
  return markFavoriteUncatalogedRow(appSummaryFromDetail(detail));
}

/** 标记为未收录行，空分类回落至 external。 */
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

/** 按记录表 `isCataloged` 为行打标，记录优先于目录列表。 */
export function markFavoriteRowByRecord(summary: AppSummary, isCataloged: boolean): AppSummary {
  if (isCataloged) return { ...summary, is_cataloged: true };
  return markFavoriteUncatalogedRow(summary);
}

/** 合并收藏与关注记录中的 `is_cataloged` 标记（任一显式为 `false` 即未收录）。 */
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
      const flag = isCatalogedFailClosed(e.is_cataloged);
      map.set(k, map.has(k) ? (map.get(k) as boolean) && flag : flag);
    }
  }
  return map;
}

/**
 * 记录表示值读取：归一键缺席即未收录（`?? false`），调用方无需重复空值合并。
 */
function isRecordCataloged(record: ReadonlyMap<string, boolean>, key: string): boolean {
  return record.get(key) ?? false;
}

/** 判定是否为无实质元数据与星叉数的空壳占位行。 */
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

/** 图标为空或非远端 URL 时需要触发轮换回填。 */
export function needsFavoriteIconWarm(icon: unknown): boolean {
  if (typeof icon !== 'string') return true;
  const value = icon.trim();
  if(!value||!isRemoteIcon(value))return true;
  return false;
}

/** 求 `favoriteIds ∖ (catalogLower ∪ extraLower)`，大小写归一去重并保留原始 id。 */
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

interface ExtraListSlot {
  items: AppSummary[];
  setItems: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  ref: React.MutableRefObject<AppSummary[]>;
}

interface UseUncatalogedJoinParams {
  favoriteIds: Set<string>;
  watchedIds: Set<string>;
  apps: AppSummary[];
  extraSlot: ExtraListSlot;
}

/** 收藏/关注未收录行的 cache-first left-join：先同步占位，再从本地详情缓存回填并按记录打标。 */
export function useUncatalogedJoin({ favoriteIds, watchedIds, apps, extraSlot }: UseUncatalogedJoinParams) {
  const { items: uncatalogedExtraApps, setItems: setUncatalogedExtraApps, ref: uncatalogedExtraAppsRef } = extraSlot;
  const favoriteExtraInflightRef = useRef<Set<string>>(new Set());
  // 记录收录标记表（归一小写键 → is_cataloged，行打标唯一依据；目录 apps 仅补充去重）。
  const recordCatalogedRef = useRef<Map<string, boolean>>(new Map());
  const appsRef = useRef(apps);
  appsRef.current = apps;
  // 本地橘黄：统一经 selectors 搬运标记（蓝优先，去重不动），经 ref 读取最新目录避免闭包陈旧。
  const withLocalMarkOuter = (row: AppSummary): AppSummary => annotateLocalSource(row, appsRef.current);

  // Per-row manual loader: explicit Load info for one uncataloged id (detail + icon cycle).
  const loadUncatalogedDetail = useCallback(async (favId: string): Promise<void> => {
    const raw = typeof favId === 'string' ? favId.trim() : '';
    if (!raw) return;
    const key = normalizeId(raw);
    if (!key || favoriteExtraInflightRef.current.has(key)) return;
    favoriteExtraInflightRef.current.add(key);
    try {
      let fetched = false;
      let summary: AppSummary;
      try {
        const detail = await tauriApi.getAppDetails(raw);
        summary = favoriteSummaryFromDetail(detail);
        fetched = true;
      } catch {
        summary = makeFavoritePlaceholderSummary(raw);
      }
      // 手动拉取行同样按记录打标（记录缺席即未收录），本地同 id 叠加黄标。
      summary = withLocalMarkOuter(
        markFavoriteRowByRecord(summary, isRecordCataloged(recordCatalogedRef.current, key)),
      );
      const k = normalizeId(summary.id);
      if (k) {
        setUncatalogedExtraApps((prev) => {
          let found = false;
          const next = prev.map((e) => {
            if (normalizeId(e.id) === k) {
              found = true;
              return fetched ? summary : e;
            }
            return e;
          });
          if (found) return fetched ? next : prev;
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
        admitIconCycleResult(summary.id, cycle, {
          patch: (tid, icon) => {
            setUncatalogedExtraApps((prev) => patchAppIconList(prev, tid, icon));
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
      if (uncatalogedExtraAppsRef.current.length > 0) setUncatalogedExtraApps([]);
      recordCatalogedRef.current = new Map();
      return;
    }
    const unionIds = new Set<string>([...favoriteIds, ...watchedIds]);
    const unionLower = normalizeIdLowerSet(unionIds);
    const catalogLower = buildCatalogIdSet(apps);
    // 本地橘黄：占位/富卡同 id 经 selectors 叠加 source='local'
    //（蓝优先：已验证行不叠加；去重仍远端优先，仅搬标记）。
    const withLocalMark = (row: AppSummary): AppSummary => annotateLocalSource(row, apps);
    const current = uncatalogedExtraAppsRef.current;
    // 收录到达或取消收藏/关注即驱逐（大小写归一），避免与目录行双显或残留已移除条目
    const remainingExtras =
      current.length > 0
        ? current.filter((e) => {
            const k = normalizeId(e.id);
            return Boolean(k) && unionLower.has(k) && !catalogLower.has(k);
          })
        : current;
    if (remainingExtras.length !== current.length) {
      setUncatalogedExtraApps(remainingExtras);
    }
    const remainingExtraKeys = new Set<string>();
    for (const e of remainingExtras) {
      const k = normalizeId(e.id);
      if (k) remainingExtraKeys.add(k);
    }
    // 收藏+关注 union 求缺：任一集合未收录即合成（共用同一占位 helpers/去重/inflight 口径）。
    const missing = findMissingIds(unionIds, catalogLower, remainingExtraKeys).filter(
      (id) => !favoriteExtraInflightRef.current.has(normalizeId(id)),
    );
    if (missing.length === 0 && remainingExtras.length === 0) return;
    let cancelled = false;
    // 同步追加占位行，确保缺失条目立即可见
    if (missing.length > 0) {
      const knownRecords = recordCatalogedRef.current;
      setUncatalogedExtraApps((prev) => {
        const seen = new Set(prev.map((e) => normalizeId(e.id)));
        const toAdd: AppSummary[] = [];
        for (const id of missing) {
          const k = normalizeId(id);
          if (!k || seen.has(k) || catalogLower.has(k)) continue;
          seen.add(k);
          toAdd.push(
            withLocalMark(makeFavoritePlaceholderSummary(id, knownRecords.get(k) ?? false)),
          );
        }
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
    }
    // 并行拉取本地详情缓存与收藏/关注记录，先重标既有行再合入富卡行
    const uncatalogedIds = findMissingIds(unionIds, catalogLower);
    void Promise.all([
      (uncatalogedIds.length > 0 ? tauriApi.getCachedAppDetailsBatch(uncatalogedIds) : Promise.resolve([])).catch(() => null),
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
        rich.push(withLocalMark(markFavoriteRowByRecord(hit, record.get(k) ?? false)));
      }
      setUncatalogedExtraApps((prev) => {
        if (prev.length === 0 && rich.length === 0) return prev;
        const next = [...prev];
        const indexByKey = new Map<string, number>();
        next.forEach((e, i) => {
          const k = normalizeId(e.id);
          if (k && !indexByKey.has(k)) indexByKey.set(k, i);
        });
        let changed = false;
        // 按最新记录重标既有行，本地同 id 叠加黄标
        next.forEach((e, i) => {
          const k = normalizeId(e.id);
          const flag = k ? record.get(k) : undefined;
          let cur: AppSummary = e;
          if (flag !== undefined && e.is_cataloged !== flag) {
            cur = markFavoriteRowByRecord(e, flag);
          }
          const withLocal = withLocalMark(cur);
          if (withLocal !== e) {
            next[i] = withLocal;
            changed = true;
          } else if (cur !== e) {
            next[i] = cur;
            changed = true;
          }
        });
        // 合入富卡行，跳过目录已收录项避免双显
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
    return () => {
      cancelled = true;
    };
  }, [favoriteIds, watchedIds, apps]);

  return {
    uncatalogedExtraApps,
    setUncatalogedExtraApps,
    uncatalogedExtraAppsRef,
    loadUncatalogedDetail,
  };
}
