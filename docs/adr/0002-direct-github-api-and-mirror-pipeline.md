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
   - 镜像作用于安装包下载通道（`MirrorManager::rewrite_installer_asset_url_resolved`，应用安装与仅下载），下载器只把实际生效的镜像 host 加入 per-client `no_proxy`；唯一例外是官方默认收录清单 `catalog.json`：首跳传输失败 / 429 / 5xx 时经当前自定义镜像或 `gh-proxy.com` 重试一次并严格校验结构（见 ADR-0025 §2.5）。checksum 清单、API、README 正文、图标、趋势与自定义清单源一律直连或走系统代理，失败即失败，不绕行下载镜像重试。客户端自更新使用 `tauri.conf.json` 预置的 endpoint 列表（一条 `gh-proxy.com` 前缀与一条 GitHub 直连），独立于设置页所选镜像。
   - 收录清单由独立生态仓库 `z-store-catalog` 维护，清单同步语义以 ADR-0009 与 `CONTEXT.md` D2 为准。
2. **手动测速与手动切换**：
   - 镜像模式分为两项：`direct`（官方直连）与 `custom`（自定义加速前缀，默认 `https://gh-proxy.com`）。
   - 测速由设置页手动触发（`NetworkDataSection` → `test_proxy`），结果以内联延迟指示展示。
   - 切换由设置页手动保存代理前缀，非法前缀在入库前校验拒绝并保持原状；无后台定时 HEAD 测速、自动故障转移或常驻节点延迟徽章。
