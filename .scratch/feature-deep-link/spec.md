# Feature E: 系统协议唤起与多端原生引擎 (System URL Scheme & Multi-Platform Native Engine)

## 1. 目标与背景

随着 Z-Store 逐步走向成熟，需要具备与操作系统深度集成（通过系统协议外部唤起直达安装）、跨多平台（macOS / Linux / Android）统一发布包调度安装，以及实时配额透明化的能力：
1. **系统协议注册与 Deep Link 路由**：注册系统级 `zstore://` URL Scheme，支持从浏览器网页、GitHub README 徽章或第三方应用直接一键唤起 Z-Store 并直达指定应用详情或执行安装；
2. **实时 API 速率感知器与状态胶囊**：在界面顶部或状态栏提供醒目的 API 配额健康胶囊，点击即可一键跳转至设置配置 Token，彻底终结网络限流困扰；
3. **多端原生安装管道扩展 (macOS / Linux)**：扩展 `InstallerEngine`，在跨平台抽象层落地 macOS（DMG 挂载拷贝 / PKG 安装器）及 Linux（AppImage 赋权运行 / Deb 与 RPM 系统提权包管理）；
4. **Android 端 Shizuku 免 Root 静默安装预研**：产出 Android 平台移植与基于 Shizuku IPC 的自动化静默安装架构设计方案。

## 2. 核心架构与功能模块

1. **`zstore://` URL Scheme 系统注册与路由分发**
   - Windows 注册表注册：`HKCU\Software\Classes\zstore`；
   - 协议路由模式：
     - `zstore://app/{app_id}`：唤起窗口并打开应用详情弹窗；
     - `zstore://install/{app_id}`：唤起并触发一键获取/安装流程；
     - `zstore://search?q={query}`：唤起窗口并填充搜索词触发检索；
     - `zstore://developer/{owner}`：唤起并打开对应开发者全景主页；
     - `zstore://view/{view}`：唤起窗口并快速切换至指定核心视图（如 updates, installed, settings 等）；
   - IPC 命令 `handle_deep_link(url: String)` 支持前端与外部进程调用。

2. **实时 API 速率限制胶囊指示器 (`RateLimitPill`)**
   - 在前端顶部栏（`TitleBar.tsx`）右侧嵌入 Fluent 2.0 速率配额胶囊（如 `🟢 API 4980/5000` 或低配额告警 `🟡 API 12/60`）；
   - 悬浮显示配额重置时间与状态说明，点击直接调起设置中心的 Multi-Forge PAT 配置面板。
   - > 校准（以代码为准）：主界面无胶囊——`TitleBar.tsx` 未嵌入 Pill，仅账号卡片按需管理 Token；保留 `zstore://quota-updated` 监听（`services/api.ts:onQuotaUpdated`）做配额同步。

3. **macOS & Linux 原生安装执行管道 (`InstallerEngine`)**
   - macOS 管道：
     - `.dmg`: 命令行 `hdiutil attach -nobrowse` -> 探测挂载卷内 `.app` -> 拷贝至 `/Applications` 或用户目录 -> `hdiutil detach`；
     - `.pkg`: 调用 `installer -pkg <path> -target CurrentUserHomeDirectory`；
   - Linux 管道：
     - `.AppImage`: `chmod +x` -> 移动至用户可执行路径（如 `~/.local/bin`）-> 自动生成 `.desktop` 快捷方式桌面项；
     - `.deb`: `pkexec dpkg -i <path>` 或 `apt install <path>`；
     - `.rpm`: `pkexec rpm -i <path>`。

4. **Android Shizuku 静默安装预研方案**
   - 详尽阐述 Android 11+ 架构下基于 Binder 与 Shizuku Server 提权进行 `PackageInstaller.Session` 静默分包安装的架构设计与实现原型。
