/**
 * `restoreOrFetchIconCycle().remote_url` 的 http(s) 真值提取（唯一口径）：
 * 非 string / 空白 / 非 http(s) 一律空串——`data:` 即时态（IPC 临时）永不冒充
 * 可持久化真值；落盘/回填一律消费本函数结果。
 */

/** 提取 remote_url 的 http(s) 真值，非法即空串。 */
export function resolveRemoteIconUrl(
  cycle: { remote_url?: unknown } | null | undefined,
): string {
  const remote = typeof cycle?.remote_url === 'string' ? cycle.remote_url.trim() : '';
  return /^https?:\/\//i.test(remote) ? remote : '';
}
