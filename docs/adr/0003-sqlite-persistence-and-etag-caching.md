# ADR-0003: 嵌入式 SQLite 持久化与 ETag 条件请求缓存

- **状态**: Accepted
- **日期**: 2026-09-03
- **决策者**: 架构与核心团队

## 上下文

客户端需要离线可用性、已安装应用生命周期追踪以及抵御 GitHub API 严格限流（未认证 60次/小时）。

## 决策

1. 选用 Rust 嵌入式关系型数据库 `rusqlite`（开启 `bundled` 特性，零外部环境依赖），在本地用户目录 `%LOCALAPPDATA%/ZStore/z_store.db` 统一管理数据。
2. **ETag 条件请求缓存机制**：
   - 建立 `api_etag_cache` 表，存储 GitHub 各 Release 接口返回的 ETag 标识与 Payload 快照。
   - 发起更新轮询时携带 `If-None-Match: <etag>` 请求头。若内容无更新，GitHub 返回 `304 Not Modified`，完全不扣减每小时 API 限额，实现无限制零配额更新检测。
3. 建立 `installed_apps` 表维护已安装应用的安装途径（MSI/便携版）、路径、安装哈希与快捷方式信息。
4. 建立 `user_settings` 表与 `user_favorites` 表维护外观主题、当前镜像节点、Token 与本地收藏夹。
