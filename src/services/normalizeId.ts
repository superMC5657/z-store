/**
 * Canonical App Id 前端唯一归一口（ADR-0010）。
 *
 * - 后端全形态 canonical（`owner/repo` / `forge[:host]:owner/repo` 解析）唯一源在
 *   `src-tauri/src/forge/coord.rs`（`RepositoryUrlParser` / `canonical_app_id` /
 *   `canonical_lookup_id` / `canonical_app_id_from_parts`）；前端不另立解析器。
 * - 前端散装 `trim().toLowerCase()` / `(x || '').toLowerCase()` 一律经此，不另立
 *   normalizer（`platformFilter` loading 键语义归 `lib/platformFilter`，键归一与其同值）。
 */
/** id 归一：`trim().toLowerCase()`，非字符串按空处理。 */
export function normalizeId(id: unknown): string {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase();
}

/** 归一去重保序：去空 + 按小写去重。 */
export function normalizeIdSet(ids: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const k = normalizeId(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 归一 id 集（Set 口径，`normalizeIdSet` 的 Set 形态）。
 * 去空 + 小写去重；调用方一律经此建索引。
 */
export function normalizeIdLowerSet(ids: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const raw of ids) {
    const k = normalizeId(raw);
    if (k) out.add(k);
  }
  return out;
}
