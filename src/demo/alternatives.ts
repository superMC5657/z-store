import builtinAlternatives from '../data/builtin-alternatives.json';

/** 演示站商业软件「开源平替」映射字典（与 Rust `github/alternatives.rs` 共享 `src/data/builtin-alternatives.json`）。 */
const BUILTIN_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = builtinAlternatives;

/** 合并显式 `alternatives` 与内置映射，大小写不敏感去重并保留首次出现格式。 */
export function resolveAlternatives(explicit: readonly string[] | undefined, canonicalId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const builtin = BUILTIN_ALTERNATIVES[canonicalId.trim().toLowerCase()] ?? [];
  for (const raw of [...(explicit ?? []), ...builtin]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}
