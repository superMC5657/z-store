# Issue 03: GitHub Starred 仓库同步与 Release 过滤引擎

Status: resolved

## 描述

实现自动发现与同步用户 GitHub Starred 仓库的功能：
1. 后端同步引擎：
   - 支持通过用户个人访问令牌（PAT）或输入的 GitHub 用户名，拉取其 Starred 仓库列表（调用 GitHub API `/users/{username}/starred` 或 `/user/starred`）；
   - 过滤与匹配算法：比对 Z-Store Catalog 识别已收录应用，以及过滤具备 Windows 可安装产物的开源软件；
   - 注册 Tauri IPC 命令 `sync_github_starred(username: Option<String>) -> Result<StarredSyncResult, String>`。
2. 前端展示与交互：
   - 在「我的收藏」视图（`FavoritesView.tsx`）增加 Tab 切换：「⭐️ 本地收藏」与「🌟 GitHub Starred 同步」；
   - 提供「🔄 立即同步已 Star 软件」按钮，支持输入用户名快速拉取；
   - 结果列表展示匹配到的可安装开源应用卡片，支持一键批量安装与一键加入本地收藏夹。
3. 单元测试覆盖 Starred 列表解析与 Catalog 交叉比对。

## Comments

- 针对未收录但在 GitHub Releases 中有 Windows 资产的项目，允许用户一键导入并在 Z-Store 中纳管。

## Answer

已完成 GitHub Starred 仓库同步与呈现全链路：
1. 在 `models.rs` 中定义了 `StarredSyncResult`，包含总 Star 数量、Catalog 匹配项以及其他仓库列表；
2. 在 `github.rs` 中实现了 `sync_starred_repos(username, token)`，自动适配 PAT 认证模式或公开用户名拉取模式，并实现交叉比对与网络异常降级兜底；
3. 在 `commands.rs` 中实现 `sync_github_starred` 命令并在 `lib.rs` 中完成 IPC 暴露；
4. 在 `FavoritesView.tsx` 中新增「⭐️ 本地收藏」与「🌟 GitHub Starred 同步」双视图切换，支持用户名快速查询、单键全量纳入收藏与一键安装交互；
5. 单元测试 `test_sync_starred_repos_fallback` 已验证通过。

