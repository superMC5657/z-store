# ADR-0013：Feed 契约（Discover/Search 分页与排序锁死）

- 状态：Accepted
- 日期：2026-10-05

## 决策

1. Discover：首屏 20 + 续加载 20，排序 `balanced` + `seed 7` 锁死，不提供切换。
2. Search：本地 20 复用目录检索，在线翻页 `per_page 12` + `enrich` 并发 5；本地在上、在线在下拼接。
3. View 禁二次过滤：过滤只在目录/命令层做一次，View 只渲染。
4. Toolbar 已砍：首页无策略切换条。
