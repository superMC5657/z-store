/**
 * 单仓富卡派生缓存（Repo Enrich Cache）：趋势榜、在线搜索与 GitHub Star 三条链路共享的
 * 未收录仓库平台与真实版本记忆。底层与趋势 `trendEnrichCache` / `trendConfirmedOtherCache`
 * 为同一存储（12h TTL、600 条 FIFO），本模块只提供跨视图读写口：
 * - 只存具平台摘要与已确认 Other；未确认的空平台（loading）永不入池；
 * - `data:` 图标与收录态标注在池入口剥离（见 `trends/enrich`）；
 * - 列表顺序与分页缓存仍按视图隔离，这里只共享单仓派生字段。
 */
import type { AppSummary } from '../types';
import {
  isTrendConfirmedOtherFresh,
  markTrendConfirmedOthers,
  peekFreshTrendEnrich,
  putTrendEnrichMemory,
} from './trends/enrich';
import { normalizeId } from './normalizeId';

function coordKey(row: Pick<AppSummary, 'owner' | 'repo'> | undefined): string {
  if (!row || typeof row.owner !== 'string' || typeof row.repo !== 'string') return '';
  const owner = row.owner.trim();
  const repo = row.repo.trim();
  return owner && repo ? `${normalizeId(owner)}/${normalizeId(repo)}` : '';
}

function isPlaceholderVersion(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  return t === '' || t === 'latest' || t === '...';
}

/** 读共享池中新鲜（12h 内）的单仓富卡；空平台条目仅在已确认 Other 时返回。 */
export function readSharedRepoEnrich(idOrCoord: string): AppSummary | undefined {
  return peekFreshTrendEnrich(idOrCoord);
}

/** 该仓库是否已在任一视图被确认为 Other（无可安装资产）。 */
export function isSharedRepoConfirmedOther(idOrCoord: string): boolean {
  return isTrendConfirmedOtherFresh(idOrCoord);
}

/**
 * 首绘回填：行缺平台而共享池有具平台条目时补上平台（真实版本号同时替换占位版本）。
 * 无需回填时原样返回同一引用。
 */
export function hydrateRowFromSharedEnrich(row: AppSummary): AppSummary {
  if (!row) return row;
  if (Array.isArray(row.platforms) && row.platforms.length > 0) return row;
  const idKey = normalizeId(row.id);
  const hit =
    (idKey ? readSharedRepoEnrich(idKey) : undefined) ??
    (coordKey(row) ? readSharedRepoEnrich(coordKey(row)) : undefined);
  if (!hit || !Array.isArray(hit.platforms) || hit.platforms.length === 0) return row;
  const next: AppSummary = { ...row, platforms: [...hit.platforms] };
  if (isPlaceholderVersion(row.latest_version) && !isPlaceholderVersion(hit.latest_version)) {
    next.latest_version = hit.latest_version;
  }
  return next;
}

/**
 * 写回具平台：`patched`（归一 id → 平台）优先，否则取行自带的非空平台。
 * 写入具平台会同时撤销该仓的已确认 Other 标记；空平台行跳过。
 */
export function recordSharedRepoPlatforms(
  rows: readonly AppSummary[],
  patched?: ReadonlyMap<string, string[]>,
): void {
  if (!rows || rows.length === 0) return;
  const out = new Map<string, AppSummary>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    const key = normalizeId(row.id);
    if (!key) continue;
    const fromPatch = patched?.get(key);
    const platforms =
      fromPatch && fromPatch.length > 0
        ? fromPatch
        : Array.isArray(row.platforms) && row.platforms.length > 0
          ? row.platforms
          : undefined;
    if (!platforms) continue;
    out.set(key, { ...row, platforms: [...platforms] });
  }
  if (out.size > 0) putTrendEnrichMemory(out);
}

/** 写回已确认 Other（已具平台的仓库由底层守卫跳过）。 */
export function recordSharedConfirmedOthers(ids: readonly string[]): void {
  if (!ids || ids.length === 0) return;
  markTrendConfirmedOthers(ids);
}
