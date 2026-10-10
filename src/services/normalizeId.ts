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
