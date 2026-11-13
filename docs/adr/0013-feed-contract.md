# ADR-0013：Feed 契约（Discover/Search 分页与排序锁死）

- 状态：Accepted
- 日期：2026-10-05

## 决策

1. Discover：精选页展示后端按画像组装的推荐货架（`get_featured_page`，见 ADR-0023）与「继续查看」最近浏览富卡区块，不渲染「全部精选」无限滚动主流（全库浏览由 10 个分类视图与本地/在线搜索承接）。后端 `get_home_feed` 接口仍保留 `balanced` 排序契约（固定日期种子 `yyyymmdd`；`ln(stars + 1) + 0.25 * ln(forks + 1)` 质量基线叠加 `UserAffinityProfile` 动态增益；「不感兴趣」应用沉底、前 60 个内同类不连续超过 2 个）。
2. Search：本地 20 复用目录检索，在线翻页 `per_page 20` + `enrich` 并发 5；本地在上、在线在下拼接。
3. View 禁二次过滤：过滤在目录/命令层完成，View 只负责渲染。
