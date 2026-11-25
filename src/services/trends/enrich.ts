/**
 * 趋势专属 enrich 批处理（`enrich_trend_repos` IPC）与榜单辅助函数。
 * 共享富卡池本体位于 `services/repoEnrichCache.ts`，此处重导出其符号供趋势域沿用。
 */
import type { AppSummary, TrendRepo } from '../../types';
import { tauriApi } from '../api';
import { admitIconHit } from '../iconStore';
import { normalizeId } from '../normalizeId';
import {
  mergeIconSticky,
  peekRepoCardEntry,
  putRepoCard,
  takeFreshEnrichEntry,
} from '../repoEnrichCache';

export {
  REPO_ENRICH_CACHE_MAX_ENTRIES as TREND_ENRICH_CACHE_MAX_ENTRIES,
  REPO_ENRICH_CACHE_TTL_MS as TREND_ENRICH_CACHE_TTL_MS,
  appSummaryFromDetail,
  clearRepoConfirmedOtherCache as clearTrendConfirmedOtherCache,
  clearRepoEnrichCache as clearTrendEnrichCache,
  detailHealKeysFor,
  diffRichSummary,
  evictRepoEnrichKeys as evictTrendEnrichKeys,
  fillMissingFromPrev,
  isPlaceholderDescription,
  isRepoConfirmedOtherFresh as isTrendConfirmedOtherFresh,
  markConfirmedOthersFreshNow,
  markRepoConfirmedOther as markTrendConfirmedOther,
  markRepoConfirmedOthers as markTrendConfirmedOthers,
  mergeIconSticky,
  peekFreshRepoCard,
  peekFreshSettledRepoCard as peekFreshTrendEnrich,
  putRepoEnrichMemory as putTrendEnrichMemory,
  snapshotRepoConfirmedOthers as snapshotTrendConfirmedOthers,
  snapshotSettledRepoCards as snapshotTrendEnrichCache,
  snapshotRepoCardsForRepos as snapshotTrendRepoCards,
  sweepExpiredRepoEnrichCache as sweepExpiredTrendEnrichCache,
  takeFreshEnrichEntry,
  unmarkRepoConfirmedOther as unmarkTrendConfirmedOther,
  unmarkRepoConfirmedOthers as unmarkTrendConfirmedOthers,
  upsertRepoCardFromDetail,
} from '../repoEnrichCache';

/** 单次 enrich 最多 40 仓一次取回。 */
export const TREND_ENRICH_MAX_TOTAL = 40;

function trendEnrichKey(owner: string, repo: string): string {
  return `${normalizeId(owner)}/${normalizeId(repo)}`;
}

/** 批量补全未收录 `TrendRepo` 摘要（单次最多 40 条）；传输失败静默返回已命中部分。 */
async function enrichTrendReposCore(
  repos: TrendRepo[],
  force: boolean,
  board?: string,
): Promise<Map<string, AppSummary>> {
  const out = new Map<string, AppSummary>();
  const missing: TrendRepo[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const r of repos) {
    const key = trendEnrichKey(r.owner, r.repo);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!force) {
      const hit = peekRepoCardEntry(key);
      if (hit && takeFreshEnrichEntry(key, now)) {
        out.set(key, hit);
        continue;
      }
    }
    // 缺席、过期或 force：本次重拉（落定后写透刷新时间戳）。
    missing.push(r);
  }
  if (missing.length === 0) return out;
  const capped = missing.slice(0, TREND_ENRICH_MAX_TOTAL);
  let summaries: (AppSummary | null)[];
  try {
    const payload = capped.map((r) => ({ owner: r.owner, repo: r.repo }));
    summaries = board
      ? await tauriApi.enrichTrendRepos(payload, force, board)
      : await tauriApi.enrichTrendRepos(payload, force);
  } catch {
    return out;
  }
  const at = Date.now();
  capped.forEach((r, i) => {
    let s = summaries[i];
    if (!s || !Array.isArray(s.platforms)) return;
    const key = trendEnrichKey(r.owner, r.repo);
    // 确认图标（含 data: 与远端 URL）注入 iconStore M1 缓冲（via=m2），
    // 池内 data: 剥空后 resolveIconWithBuffer 仍能从 M1 回读直显。
    const rawIcon = typeof s.icon === 'string' ? s.icon.trim() : '';
    if (rawIcon !== '') {
      admitIconHit({ id: key, icon: rawIcon, via: 'm2' });
      const idKey = typeof s.id === 'string' ? normalizeId(s.id) : '';
      if (idKey && idKey !== key) admitIconHit({ id: idKey, icon: rawIcon, via: 'm2' });
    }
    // data: 原样透出供当次直显；池入口剥空 data: 但保留富卡本身。
    s = mergeIconSticky(peekRepoCardEntry(key), s);
    out.set(key, s);
    if (s.is_cataloged === true) return;
    putRepoCard(key, s, at);
  });
  return out;
}

export async function enrichTrendRepos(
  repos: TrendRepo[],
  opts?: { forceRefresh?: boolean; board?: string },
): Promise<Map<string, AppSummary>> {
  return enrichTrendReposCore(repos, opts?.forceRefresh === true, opts?.board);
}

/** 格式化星数显示（>=1000 显示为 `k`）。 */
export function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/** 按 canonical id 或 `owner/repo` 匹配本地收录应用（需 owner 一致，避免同名仓库误匹配）。 */
export function matchCatalogApp(trend: TrendRepo, catalogApps: AppSummary[]): AppSummary | undefined {
  const tId = normalizeId(trend.id);
  const tOwner = normalizeId(trend.owner);
  const tRepo = normalizeId(trend.repo);

  const tFullName = tOwner && tRepo ? `${tOwner}/${tRepo}` : '';

  return catalogApps.find((app) => {
    const aId = normalizeId(app.id);
    const aOwner = normalizeId(app.owner);
    const aRepo = normalizeId(app.repo);
    const aFullName = aOwner && aRepo ? `${aOwner}/${aRepo}` : '';

    // 1. canonical id 全等
    if (tId && aId && aId === tId) return true;
    // 2. 归一 fullName 相等（tId 本身即 fullName 的情形 + owner/repo 拼出的 fullName）
    if (tId && aFullName && aFullName === tId) return true;
    if (tFullName && aFullName && aFullName === tFullName) return true;
    // 3. owner + repo 同时相等（owner 佐证）
    if (tOwner && tRepo && aOwner === tOwner && aRepo === tRepo) return true;

    return false;
  });
}
