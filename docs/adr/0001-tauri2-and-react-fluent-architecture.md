# ADR-0001: 采用 Tauri 2 与 React 19 + Fluent 矢量图标架构

- **状态**: Accepted
- **日期**: 2026-09-03
- **决策者**: 架构与产品团队

## 上下文

Z-Store 是一款开源跨平台桌面应用商店，面向 Windows 11，并兼容 Linux 与 macOS（同时在清单结构与平台筛选中建模 Android 与 iOS 生态）。需要低内存开销（≤ 80MB）、轻量化分发体积（≤ 15MB）、快速启动（≤ 1.8s）以及一致的现代桌面界面质感。

## 决策

1. 选择 **Tauri 2 + Rust** 作为应用核心底座，相比 Electron（体积 >150MB、常驻内存 >200MB），Tauri 2 利用操作系统内置 WebView，具备 <15MB 打包体积、启动快（≤ 1.8s）与内存开销低（≤ 80MB）的优势。
2. 前端选用 **React 19 + TypeScript + Vite 6**，采用纯原生 CSS Tokens 实现 **Linear 去彩单色设计体系**（黑白灰画布、hairline 微边框、6/8px 圆角、深浅双模与轻量微动效），不引入重型第三方商业 UI 组件库。
3. 遵循 ADR-0005 确立的自适应双模图标与无边框贴靠窗口。
4. 建立统一的 **Fluent 2 矢量功能图标体系**，全站功能按钮、导航菜单、设备平台标识及状态反馈均采用轻量线性矢量图标（`lucide-react` 与统一单色 SVG）配合 `currentColor` 动态着色，结合纯 CSS 微动效与状态指示原点，保障统一的系统级视觉语言（此处的 Fluent 仅指矢量图标体系，不含 Acrylic/品牌蓝，详见 `CONTEXT.md` D4）。
