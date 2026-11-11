# ADR-0019：资产面手动缓存与非资产面自动拉取

- 状态：Accepted
- 日期：2026-10-17
- 关联：ADR-0007（补充并细化更新发现与资产面的网络触发边界）、D2、`Cache TTL` / `is_cataloged` 词汇行
- 范围：后端（`updates_check` force 门控 + `update_results` 快照 + 收藏/关注收录标记）；前端仅透传 `forceRefresh` 参数。

## 1. 背景

更新中心在启动/登录时自动探查会消耗大量配额且与手动刷新预期冲突；收藏/关注中的未收录条目需要持久化收录标记以区分读卡数据源。

## 2. 决策

1. **资产面（已安装应用、更新中心、收藏）仅手动触发网络**：`fetch_app_latest_version_lightweight` 与 `check_for_updates` 默认只读本地（判定行 → 详情行 → 收录库默认版本），仅前端请求键 `forceRefresh=true` 走 ETag 轻量探查并写入 `update_results`；`get_cached_updates` 恒为 DB 快照读。
2. **非资产面（搜索/趋势/平台推导/图标/首页/清单同步）默认自动拉取**：TTL/ETag 复用与 `forceRefresh` 透传同时生效（平台与详情侧 `force` 跳过 TTL 快径，用户显式发起的在线搜索与趋势侧默认在线直查）。
3. **收藏/关注记录自带收录标记**：`user_favorites` / `watched_apps` 持久化 `is_cataloged`（写入时按内存目录判定一次，启动、清单同步完成与本地收录状态切换后回填），前端凭标记选择收录库或详情缓存读卡。

## 3. 后果

- 资产面仅在显式手动刷新时触网，其余时间复用本地缓存与更新快照；非资产面的 TTL、ETag 协商与离线降级语义见 ADR-0007，`CONTEXT.md` D2 与词汇表同步描述此划分。
