# ADR-0002: 客户端直连 GitHub API 与加速镜像下载管道

- **状态**: Accepted
- **日期**: 2026-09-03
- **决策者**: 核心工程团队

## 上下文

客户端在不依赖任何自建中心化后端服务器（零服务器开销）的前提下，需要为中国大陆用户提供稳定可靠的发现、检索与大文件二进制下载能力。

## 决策

1. **直连 API + 镜像大文件分流**：
   - GitHub API 元数据查询（JSON）轻量级，优先直接调用官方 REST API，并支持用户配置个人 Personal Access Token（将未登录的 60次/小时上限提升至 5000次/小时）。
   - GitHub Releases 产物（二进制安装包）体积较大，可经用户配置的加速镜像前缀（如 `gh-proxy.com`）重写下载 URL。
   - 镜像只作用于安装包下载通道（`MirrorManager::rewrite_installer_asset_url`，应用安装与仅下载）；checksum 清单、README 正文、图标、趋势与目录清单一律直连，失败即直连失败、不再套代理重试。客户端自更新走 `tauri.conf.json` 预置的 endpoint 列表（一条 `gh-proxy.com` 前缀 + 一条 GitHub 直连），不读设置页所选镜像。
   - 收录清单已迁至独立仓库 `z-store-catalog`，清单同步语义以 ADR-0009 与 `CONTEXT.md` D2 为准。
2. **手动测速与手动切换**：
   - 镜像状态只有两项：`direct`（官方直连）与 `custom`（自定义加速前缀，默认 `https://gh-proxy.com`）。`MirrorManager::get_mirror_statuses` 的 `latency_ms` 恒为 0，不预置任何探测结果。
   - 测速是设置页的手动按钮（`NetworkDataSection` → `test_proxy`），结果以内联延迟指示展示。
   - 切换同样手动：在设置页填写或保存代理前缀，非法前缀入库前拒绝并保持原状。没有后台定时 HEAD 测速、没有自动故障转移，界面角落也不挂节点延迟徽章。
