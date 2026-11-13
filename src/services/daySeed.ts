/**
 * 日期种子：本地日期的 `yyyymmdd` 整数。精选页货架与「全部精选」主流共用，
 * 同一天内结果稳定，隔天换一批（ADR-0023）。
 */
export function daySeed(now: Date = new Date()): number {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}
