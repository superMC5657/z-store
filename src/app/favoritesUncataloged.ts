import type { AppDetail, AppSummary } from '../types';
import { appSummaryFromDetail } from '../services/trends';
import { isAvatarUrl, isRemoteIcon } from '../components/AppIcon';
import { normalizeIconCycle, type AppIconCycleResult } from '../services/api';

/**
 * 收藏未收录行 left-join 合成（数据层唯一口径，展示层只读标记）。
 *
 * 背景：`apps` 来自 `searchApps('')` 仅收录库；`FavoritesView` 按
 * `favoriteIds` 内连接过滤会丢未收录行（计数用全集 `favoriteIds.size`）。
 * 此处对 `favoriteIds ∖ apps` 合成占位 `AppSummary`，再进
 * `matchPlatformSetWithPending`（平台三态逻辑不动：占位 `platforms: []`
 * 即 pending 恒可见，落定后走正常 Other 过滤）。
 *
 * - 归一大小写：join/去重一律按 `id.toLowerCase()`，原始 id 保留原值
 *   供 `FavoritesView` 精确 `has` 命中（双键：原值 + 小写在调用方分别建索引）。
 * - 详情优先：`api.getAppDetails(id)`（后端经 `get_cached_app_detail_fallback`
 *   回退，TTL 外/离线仍可显）→ `appSummaryFromDetail`（`detail_to_summary`
 *   前端同构）；失败才用最小占位，保证行必展示。
 * - 标记：合成行一律 `is_cataloged: false` + `category: 'external'`
 *  （有详情实分类则保留实值，仅空时兜底 external），供展示层
 *   `isAppCataloged` 打标用，不参与 join/过滤/计数。
 */

export const FAVORITE_EXTERNAL_CATEGORY = 'external';
export const FAVORITE_EXTERNAL_CATEGORY_NAME = '跨平台开源';

function trimId(id: unknown): string {
  return typeof id === 'string' ? id.trim() : '';
}

export function parseFavoriteOwnerRepo(id: string): { owner: string; repo: string } {
  const clean = trimId(id);
  // 兼容 `owner/repo`、`github.com/owner/repo`、`https://.../owner/repo`、`gh:owner/repo` 等直查形态；
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
  const id = trimId(favId);
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
 * 收藏占位行图标热替口径（与搜索/最近同一套：`getAppIconCycle` 读 `app_icon_cycles`
 * 即前端侧 `resolve_confirmed_icon_from_db` 同源 + 后端 ensure/download 回填）。
 *
 * `pickFavoritePersistIconUrl`：轮换结果取可落盘持久化 URL——`remote_url` 优先，
 * `url` 非 `data:` 才兜底（`data:` 即时态永不进盘）；avatar/非远端一律置空走首字母
 * （`AppIcon.isAvatarUrl/isRemoteIcon` 同规则，与 `App.tsx` 详情回填分支一致）。
 */
export function pickFavoritePersistIconUrl(
  cycle: AppIconCycleResult | null | undefined,
): string {
  const normalized = normalizeIconCycle(cycle);
  const remote = (normalized?.remoteUrl ?? '').trim();
  const fallback = (normalized?.url ?? '').trim();
  const persist = remote !== '' ? remote : (!fallback.startsWith('data:') ? fallback : '');
  if (!persist || isAvatarUrl(persist) || !isRemoteIcon(persist)) return '';
  return persist;
}

/**
 * 摘要图标是否缺图标预热：空/avatar/非远端（首字母占位态）即需经
 * `getAppIconCycle` 查轮换；已有合法远端仅需文件预热
 * （`preloadIcons`/`getOrFetchIcon`，与搜索首屏预热同通道）。
 */
export function needsFavoriteIconWarm(icon: unknown): boolean {
  if (typeof icon !== 'string') return true;
  const value = icon.trim();
  if (!value || isAvatarUrl(value) || !isRemoteIcon(value)) return true;
  return false;
}

/**
 * 求 `favoriteIds ∖ (catalog ∪ extra)`（大小写归一，按小写去重保序）。
 * 返回原始 favId（保留原大小写供展示层精确命中），调用方按小写建双键索引。
 */
export function findMissingFavoriteIds(
  favoriteIds: Iterable<string>,
  catalogLower: ReadonlySet<string>,
  extraLower?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const raw of favoriteIds) {
    const id = trimId(raw);
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (catalogLower.has(key)) continue;
    if (extraLower?.has(key)) continue;
    missing.push(id);
  }
  return missing;
}
