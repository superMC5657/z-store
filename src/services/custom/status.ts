/**
 * 本地收录态判定唯一口径（CONTEXT.md 词汇表「本地收录态」）：
 * 实现居 services 层供 `services/custom`（mappers 等）直接消费，
 * `src/app/selectors.ts` 单一重导出保持对外承诺；调用方禁止手写
 * `collected`/`local_collected` 字面判定。
 */

/** 本地收录态判定（可提 Issue/可退回的唯一口径，`collected` 与磁盘残留 `local_collected` 同义；归档与否由调用方另判）。 */
export function isCollectedStatus(status: unknown): boolean {
  return status === 'collected' || status === 'local_collected';
}
