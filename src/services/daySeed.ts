/** 返回本地日期的 `yyyymmdd` 整数种子（同一天内结果稳定）。 */
export function daySeed(now: Date = new Date()): number {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}
