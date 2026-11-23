/** 进入精选页时生成的货架种子（32 位无符号整数）：同一次访问内稳定，下次进入换一批。 */
export function visitSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0x1_0000_0000);
}
