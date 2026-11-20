import type { AppSummary } from '../../types';
import { normalizeLoadingKey } from '../../lib/platformFilter';
import { queueAssembledRowIcons, resolveIconWithBuffer } from '../iconStore';
import { normalizeId } from '../normalizeId';
import { hydrateRowFromSharedEnrich } from '../repoEnrichCache';

function rowKey(row: Pick<AppSummary, 'id'> | undefined): string {
  return normalizeId(row?.id);
}

/** 组装在线分页行：按归一 id 去重、合并缓冲图标与共享富卡平台，并触发远端图标预热。 */
export function assembleOnlineRowsWithIcons(
  prev: readonly AppSummary[],
  incoming: readonly AppSummary[],
): AppSummary[] {
  const prevById = new Map<string, AppSummary>();
  for (const p of prev ?? []) {
    const pk = rowKey(p);
    if (pk && !prevById.has(pk)) prevById.set(pk, p);
  }
  const seen = new Set<string>();
  const deduped: AppSummary[] = [];
  for (const m of incoming ?? []) {
    const k = rowKey(m);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    deduped.push(hydrateRowFromSharedEnrich(resolveIconWithBuffer(prevById.get(k), m)));
  }
  queueAssembledRowIcons(deduped);
  return deduped;
}

/** 在线分页追加去重（保留 `prev` 已有项及数组引用）。 */
export function appendUniqueOnlineRows(
  prev: readonly AppSummary[],
  incoming: readonly AppSummary[],
): AppSummary[] {
  const assembled = assembleOnlineRowsWithIcons(prev, incoming);
  const seen = new Set<string>();
  for (const r of prev) {
    const k = rowKey(r);
    if (k) seen.add(k);
  }
  const fresh: AppSummary[] = [];
  for (const r of assembled) {
    const k = rowKey(r);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    fresh.push(r);
  }
  return fresh.length > 0 ? [...prev, ...fresh] : (prev as AppSummary[]);
}

/**
 * 平台轻量回填结果写透列表：仅补齐原 `platforms` 为空的行，其余行与未变化列表均保留原引用。
 */
export function patchRowsPlatforms(
  prev: AppSummary[],
  patched: ReadonlyMap<string, string[]>,
): AppSummary[] {
  if (patched.size === 0 || prev.length === 0) return prev;
  let changed = false;
  const next = prev.map((a) => {
    const k = normalizeLoadingKey(a.id);
    const p = k ? patched.get(k) : undefined;
    if (p && (!a.platforms || a.platforms.length === 0)) {
      changed = true;
      return { ...a, platforms: p };
    }
    return a;
  });
  return changed ? next : prev;
}
