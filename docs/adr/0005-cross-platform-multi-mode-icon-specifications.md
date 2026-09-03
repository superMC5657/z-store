# ADR-0005: 跨平台多模式应用图标（Icon）自适应架构规范与后续演化设计

## 状态
已接受 (Accepted) - 2026-09-03

## 背景
随着 Z-Store 品牌视觉标识（LOGO）系统完成 Fluent 2.0 重构，应用具备了两套核心意象形态：
- **☀️ 明亮模式形态 (D-轻1: 冰川浅蓝 / Glacier Azure)**：纯净雪白/微蓝高对比超椭圆衬底 + 晴空天蓝双环；
- **🌙 暗黑模式形态 (D-轻4: 晶透亚克力 / Frosted Acrylic)**：无实体底板 + 半透雾化亚克力边框 + 自发光浮空双环。

在多平台桌面端与移动端（Windows、macOS、Linux、iOS、Android）生态中，操作系统对“深色模式桌面图标”的支持能力存在明显的代际断层与机制分歧。为指导未来向 macOS、iOS、Android 等跨平台多端演进时的原生图标工程化落地，亟需确立统一的图标分层架构规范与多端适配指南。

---

## 决策

### 一、确立“三层图标资产分工体系 (Three-Tier Icon Architecture)”

| 资产层级 | 载体文件 | 职责范围与生命周期 | 渲染机制 |
|---|---|---|---|
| **Tier 1: 运行时内部自适应层** | `src/components/BrandLogo.tsx` | 客户端窗口内部（标题栏、设置弹窗、关于面板）。根据应用深浅色主题动态变色。 | Webview / React 矢量渲染，毫秒级状态联动 |
| **Tier 2: 操作系统外壳层** | `src-tauri/icons/*` (`.ico`, `.icns`, `.png`) | 桌面快捷方式、系统资源管理器展示、安装包 `.exe` 头、任务管理器进程。 | 操作系统原生图形管道（只读取静态多分辨率包） |
| **Tier 3: 跨平台矢量母版层** | `app-icon.svg` & `app-icon-dark.svg` | GitHub 仓库主页、文档与多平台原始设计图。集成 `@media` 响应式媒体查询。 | 标准 W3C SVG 规范 |

---

### 二、各平台深浅色桌面图标能力矩阵与开发规约

#### 1. Windows 平台（当前 MVP 核心桌面端）
- **系统能力限制**：Win32 / NSIS 打包的传统可执行程序（`.exe`），操作系统资源管理器只读取 PE 头部烧录的单一 `icon.ico`。Windows 桌面快捷方式**不支持**随系统深浅色切换而自动更换图标。
- **设计与开发规约**：
  - Windows `icon.ico` 必须固定编译为 **D-轻1 (冰川浅蓝)**；
  - 必须保留自带的雪白超椭圆衬底与微弱高光边框，确保在任何纯白壁纸、纯黑壁纸及 Windows 任务栏上均具备极高辨识度与对比度，防止被深色背景吞噬；
  - 窗口内自由享受 `BrandLogo.tsx` 带来的暗黑亚克力动态切换。

#### 2. macOS 平台
- **Dock 栏与访达主图标 (`icon.icns`)**：
  - macOS 14 及以前仅支持读取单一 `icon.icns`（采用 1024×1024 Squircle 连续曲率超椭圆标准，当前 D-轻1 完全符合 macOS Big Sur+ HIG 规范）；
  - macOS 15 (Sequoia) 与 Xcode 16 开始支持 Mac App Store 应用的 `Dark Appearance`。未来构建 Mac App 格式时，可在 Xcode `Assets.xcassets` 中挂载 `app-icon-dark.svg` 导出的暗色切片。
- **右上角菜单栏托盘图标 (Menu Bar / Status Item)**：
  - **原生支持自动黑白切换**。开发 macOS 托盘功能时，必须将托盘图标命名为带 `@2xTemplate.png` 的单色黑白蒙版（或在 Tauri Rust 代码中标记 `icon_as_template(true)`），macOS 将在浅色菜单栏自动呈现深黑，暗黑菜单栏自动呈现纯白，点击高亮时自动反色。

#### 3. iOS 平台 (iOS 18+)
- **系统能力**：iOS 18 起系统主屏幕正式支持深色图标（Dark Icons）与单色着色（Tinted Icons）。
- **未来开发规约**：
  - 启动 `tauri ios init` 接入移动端时，在 Xcode 的 `AppIcon.appiconset` 配置三态映射：
    - `Any Appearance`（白天） $\rightarrow$ 映射 **D-轻1 (冰川浅蓝)**；
    - `Dark Appearance`（暗黑） $\rightarrow$ 映射 **D-轻4 (晶透亚克力 / 暗夜流光)**；
    - `Tinted Appearance`（单色） $\rightarrow$ 映射提炼后的纯白色矢量剪影。

#### 4. Android 平台 (Android 13+)
- **系统能力**：Android 13+ 支持主题图标（Themed Icons / Material You 动态取色）。
- **未来开发规约**：
  - 启动 `tauri android init` 时，在 Android 清单中除了标准多分辨率 `mipmap-*` 图标外，必须配置 `mipmap-anydpi-v26/ic_launcher.xml`：
    - 前景图（Foreground）：使用自适应双环；
    - 背景图（Background）：白昼使用浅蓝，暗夜使用深曜石；
    - 单色蒙版（`<monochrome>`）：使用纯单色 Alpha 通道双环，交由 Android 系统 Material You 算法随壁纸动态着色。

---

### 三、工程化构建命令与工具链指南

1. **统一更新系统静态图标**：
   在修改根目录矢量母版后，执行 Tauri CLI 原生烘焙命令即可自动全量重构 `src-tauri/icons/`：
   ```bash
   npx tauri icon app-icon.svg
   ```
2. **多端独立深色包烘焙建议**：
   未来为 iOS/Android 单独烘焙暗色资产时，可直接调用：
   ```bash
   npx tauri icon app-icon-dark.svg -o src-tauri/icons-dark/
   ```

---

## 后果与价值
- **架构清晰性**：彻底理清了“操作系统原生外壳”与“客户端 Webview 运行时”之间的图标分工边界；
- **跨平台演进资产完备**：未来在向 macOS 托盘、iOS 18 深色主屏及 Android 动态取色拓展时，具备明确的工程规约与已就绪的母版资产。
