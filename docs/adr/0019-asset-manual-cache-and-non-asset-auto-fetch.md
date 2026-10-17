# ADR-0019：资产面手动缓存与非资产面自动拉取

- 状态：Accepted
- 日期：2026-10-17
- 关联：ADR-0007（部分替代其决策 2 更新发现条款）、D2、`Cache TTL` / `is_cataloged` 词汇行
- 范围：仅后端（`updates_check` force 门控 + `update_results` 快照 + 收藏/关注收录标记）；前端仅透传既有 `force_refresh` 参数。

## 1. 背景

更新中心在启动/登录时自动探查消耗配额，与手动刷新预期不一致；收藏/关注中的未收录条目缺少收录态，直接影响读卡来源选择。

## 2. 决策

1. **资产面（已安装应用、更新中心、收藏）仅手动触发网络**：`fetch_app_latest_version_lightweight` 与 `check_for_updates` 默认只读本地（判定行 → 详情行 → 收录库默认版本），仅 `force_refresh=Some(true)` 走 ETag 轻量探查并写入 `update_results`；`get_cached_updates` 恒为 DB 快照读。
2. **非资产面（搜索/趋势/平台推导/图标/首页/清单同步）默认自动拉取**：TTL/ETag 复用保留，`force_refresh` 保留透传（手动按钮统一签名；平台与详情侧 `force` 跳过 TTL 快径，搜索与趋势侧默认即在线直查）。
3. **收藏/关注记录自带收录标记**：`user_favorites` / `watched_apps` 持久化 `is_cataloged`（写入时按内存目录判定一次，启动与清单同步完成后回填），前端凭标记选择收录库或详情缓存读卡。

## 3. 后果

- ADR-0007 决策 2 更新发现条款不再适用于资产面，其余（TTL、ETag 协商、降级）不变；`CONTEXT.md` D2 与词汇表描述此划分。
