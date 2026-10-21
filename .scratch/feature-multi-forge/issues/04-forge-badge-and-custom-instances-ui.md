# Issue 04: 前端多源图标徽章展示与自建实例接入配置

Status: resolved

## 描述

在前端实现代码托管源可视化标识、自建实例管理与跨平台直连体验：
1. 视觉徽章展示：
   - 在 `AppCard`、`AppDetailModal` 中增加源站徽章（🐙 GitHub、🏔️ Codeberg、🍵 Gitea、🦊 GitLab）；
   - `AppSummary` 与 `AppDetail` 增加 `forge?: string` 与 `forge_host?: string`。
2. 设置中心管理面板：
   - 在 `SettingsView.tsx` 中新增「🌐 代码托管平台与 API 密钥管理」卡片；
   - 默认提供 `github.com` 与 `codeberg.org` 快捷配置通道；
   - 支持 "+ 添加自建 Gitea / Forgejo 实例"（输入域名如 `git.disroot.org` 与可选 Access Token）；
   - 展示每个主机的在线连通性与 API 剩余配额状态指示器。
3. 搜索与直连体验：
   - 顶部搜索框粘贴 `https://codeberg.org/...` 等外链时，自动调用 `RepositoryUrlParser` 穿透解析并展示产物卡片。
4. 前端类型检查与构建验证通过。

## Comments

- 纯纯 Fluent 2.0 风格，提供良好的视觉层级与状态反馈。

## Answer

已完成前端多源图标徽章、设置管理面板与自建实例接入：
1. 在 `AppCard.tsx` 与 `AppDetailModal.tsx` 中增加了源站平台徽章（🐙 GitHub、🏔️ Codeberg、🍵 Gitea 等）与精准仓库跳转链接；
2. 在 `SettingsView.tsx` 中升级打造了「🌐 多代码托管平台与 API 令牌管理 (Multi-Forge)」专区，支持直观配置 GitHub/Codeberg Token、连通性探测、API 剩余配额监测以及自建实例增删；
3. `search_apps` 与 `get_app_details` 支持跨平台外链实时嗅探与解析；
4. `tsc` 类型检查与 `npm run build` 打包均 0 报错通过。

