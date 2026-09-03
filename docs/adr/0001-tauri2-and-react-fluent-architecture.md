# ADR-0001: 采用 Tauri 2 与 React 19 + Fluent 2.0 架构

- **状态**: Accepted
- **日期**: 2026-09-03
- **决策者**: 架构与产品团队

## 上下文

Z-Store 是一款定位于开源世界的跨平台桌面应用商店，首期重点打磨 Windows 11 原生体验，并跨平台兼容 Linux、macOS 与 Android。需要极高的内存/启动性能、极致的轻量化分发体积（≤ 15MB）以及高度贴合现代操作系统美学的 UI 质感。

## 决策

1. 选择 **Tauri 2 + Rust** 作为应用核心底座，相比 Electron（体积 >150MB、常驻内存 >200MB），Tauri 2 利用操作系统内置 WebView，具备 <15MB 打包体积、启动快（≤ 1.8s）与内存开销低（≤ 80MB）的压倒性优势。
2. 前端选用 **React 19 + TypeScript + Vite 6**，采用纯原生 CSS Tokens 深度复刻 **Fluent Design System 2.0**（Windows 11 视觉规范），放弃引入冗余的第三方商业 UI 库，实现高通透亚克力毛玻璃、高光描边、深浅双模与丝滑微动效。
3. 遵循 ADR-0005 确立的自适应双模图标与无边框贴靠窗口。
