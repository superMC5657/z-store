# Issue 02: SQLite 本地持久化与 ETag 条件缓存

Status: resolved

## 描述

基于 `rusqlite` 实现嵌入式本地数据管理：
1. `installed_apps` 表：管理已安装软件清单、版本、安装方式、安装路径与 SHA-256；
2. `api_etag_cache` 表：记录 GitHub API ETag 与响应体快照，支持 304 缓存零额度更新探测；
3. `user_settings` 表与 `user_favorites` 表：持久化主题、当前镜像节点、GitHub Token 与本地收藏。

## Comments

- `src-tauri/src/db.rs` 已实现并覆盖单测（`test_installed_apps_crud`、`test_etag_cache`、`test_settings_and_favorites`），测试全部通过。
