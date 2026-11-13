# ADR-0013：Feed 契约（Discover/Search 分页与排序锁死）

- 状态：Accepted
- 日期：2026-10-05

## 决策

1. Discover：精选页上方为推荐货架（`get_featured_page`，见 ADR-0023），下方「全部精选」主流首屏 20 + 续加载 20，排序固定 `balanced`，种子为前端按本地日期给出的日期种子（`yyyymmdd`，当天稳定、隔天轮换），不提供策略切换工具条。当 `enable_local_affinity` 开启且存在本地亲和度画像信号时，`balanced` 在 `ln(stars + 1) + 0.25 * ln(forks + 1)` 质量基线上叠加 `UserAffinityProfile` 动态增益（对已知应用适度让位推新）；无信号或关闭开关时退化为对数质量基线 + 确定性轻扰动。排序后被「不感兴趣」标记的应用移到末尾，再在前 60 个内打散，同一分类不连续超过 2 个。主流滤掉推荐货架中已出现的应用。
2. Search：本地 20 复用目录检索，在线翻页 `per_page 20` + `enrich` 并发 5；本地在上、在线在下拼接。
3. View 禁二次过滤：过滤在目录/命令层完成，View 只负责渲染。
