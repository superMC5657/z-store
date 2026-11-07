# ADR-0013：Feed 契约（Discover/Search 分页与排序锁死）

- 状态：Accepted
- 日期：2026-10-05

## 决策

1. Discover：首屏 20 + 续加载 20，排序 `balanced` + `seed 7` 锁死，不提供切换。当 `enable_local_affinity` 开启且存在本地亲和度画像信号（GitHub Star/Fork/Owned 仓库特征信号或应用内 Star/收藏/Watch）时，`balanced` 策略在 `ln(stars + 1) + 0.25 * ln(forks + 1)` 质量基线上叠加 `UserAffinityProfile` 动态增益（并对已收藏/已关注种子适度让位推新），同时驱动首页「经典精选开源软件」（前 4）与「全部精选开源收录」（主列表）；无信号或关闭开关时退化为对数质量基线 + 确定性轻扰动。
2. Search：本地 20 复用目录检索，在线翻页 `per_page 20` + `enrich` 并发 5；本地在上、在线在下拼接。
3. View 禁二次过滤：过滤只在目录/命令层做一次，View 只渲染。
4. Toolbar 已砍：首页无策略切换条。
