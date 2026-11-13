import type { AppSummary } from '../../types';
import { normalizeLoadingKey } from '../../lib/platformFilter';
import { queueAssembledRowIcons, resolveIconWithBuffer } from '../iconStore';
import { normalizeId } from '../normalizeId';

function rowKey(row: Pick<AppSummary, 'id'> | undefined): string {
  return normalizeId(row?.id);
}

/**
 * 在线分页行首绘组装（搜索结果 / GitHub Star 列表共用）：
 * 1. 按归一 id 去重；
 * 2. 经 `resolveIconWithBuffer` 粘性合并旧图标 + M1 缓冲回读（保留 L5 显式空徽章保护）；
 * 3. `queueAssembledRowIcons` 触发 http 远端图标落盘预热（前 30 上限）。
 */
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
    deduped.push(resolveIconWithBuffer(prevById.get(k), m));
  }
  queueAssembledRowIcons(deduped);
  return deduped;
}

/**
 * 在线分页追加去重（先组装缓冲图标，再跳过 `prev` 已有 id）。
 * 翻页期间若上游列表位移出现重复项，以已有项为准去重并保留原数组引用（无新增时）。
 */
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
