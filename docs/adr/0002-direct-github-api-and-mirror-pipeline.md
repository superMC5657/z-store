# ADR-0002: 客户端直连 GitHub API 与加速镜像下载管道

- **状态**: Accepted
- **日期**: 2026-09-03
- **决策者**: 核心工程团队

## 上下文

客户端在不依赖任何自建中心化后端服务器（零服务器开销）的前提下，需要为中国大陆用户提供稳定可靠的发现、检索与大文件二进制下载能力。

## 决策

1. **直连 API + 镜像大文件分流**：
   - GitHub API 元数据查询（JSON）体积轻量，直接调用官方 REST API，并支持通过 GitHub OAuth Device Flow 授权登录（将未登录的 60次/小时上限提升至 5000次/小时）。
   - GitHub Releases 产物（二进制安装包）体积较大，可经用户配置的加速镜像前缀（如 `gh-proxy.com`）重写下载 URL。
   - 镜像只作用于安装包下载通道（`MirrorManager::rewrite_installer_asset_url`，应用安装与仅下载）；checksum 清单、README 正文、图标、趋势与目录清单一律直连，失败即直连失败，不绕行下载镜像代理重试。客户端自更新使用 `tauri.conf.json` 预置的 endpoint 列表（一条 `gh-proxy.com` 前缀与一条 GitHub 直连），独立于设置页所选镜像。
   - 收录清单由独立生态仓库 `z-store-catalog` 维护，清单同步语义以 ADR-0009 与 `CONTEXT.md` D2 为准。
2. **手动测速与手动切换**：
   - 镜像模式分为两项：`direct`（官方直连）与 `custom`（自定义加速前缀，默认 `https://gh-proxy.com`）。
   - 测速由设置页手动触发（`NetworkDataSection` → `test_proxy`），结果以内联延迟指示展示。
   - 切换由设置页手动保存代理前缀，非法前缀在入库前校验拒绝并保持原状；无后台定时 HEAD 测速、自动故障转移或常驻节点延迟徽章。
