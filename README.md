# Z-Store

> 基于 GitHub Releases 的跨平台开源应用商店 · 深度融合 Windows 11 Fluent Design 2.0

![Z-Store License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue)
![Tauri](https://img.shields.io/badge/Tauri-2.2-blue?logo=tauri)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react)
![Rust](https://img.shields.io/badge/Rust-1.77+-orange?logo=rust)

---

## 🌟 项目定位与核心特性

**Z-Store 致力于成为开源世界的系统级应用商店**——把 GitHub Releases 变成人人可用、一键安装、自动更新的跨平台应用市场。

- **D1 纯粹开源 (Strictly FLOSS)**: 仅收录和分发具备 OSI 认证开源协议的 GitHub 项目，杜绝商业广告与闭源推广。
- **D2 零服务器成本 (Serverless Direct API)**: 客户端直连 GitHub REST API 获取最新 Release，结合 SQLite 本地持久化与 ETag 304 缓存，零额度消耗更新检测。
- **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**: 默认利用中国大陆加速镜像代理大文件下载；下载后**强制流式计算 SHA-256** 与官方清单比对，哈希不符立即强行阻断并销毁。
- **D4 深度融合 Fluent Design 2.0**: 全面遵循微软 Windows 11 Fluent 2.0 规范，提供亚克力毛玻璃 (Acrylic)、折射描边、微动效与系统级深浅色自适应。

---

## 🚀 架构与技术栈

- **桌面底座**: Tauri 2.2 + Rust
- **前端界面**: React 19 + TypeScript 5.7 + Vite 6 + 原生 Fluent 2.0 CSS
- **本地数据库**: 嵌入式 SQLite (`rusqlite` bundled)
- **网络与下载**: `reqwest` (stream) + ETag 条件缓存 + 并发镜像测速管道
- **安装引擎**: Windows MSI (`/qn`)、Setup EXE (`/S` / `/VERYSILENT`)、便携版 ZIP 自动解压与桌面快捷方式生成

---

## 🛠️ 本地开发指南

### 前置依赖
- [Node.js](https://nodejs.org/) (>= 18) 与 [pnpm](https://pnpm.io/) (>= 9)
- [Rust](https://rustup.rs/) (>= 1.77)

### 安装与启动

```bash
# 1. 安装前端依赖
pnpm install

# 2. 启动前端浏览器开发预览
pnpm dev

# 3. 启动 Tauri 桌面完整应用
pnpm tauri dev
```

### 构建打包

```bash
# 编译类型检查
pnpm typecheck

# 构建 Windows 安装包 (NSIS)
pnpm tauri build
```

---

## 📄 许可协议

本项目基于开源协议分发，详见 LICENSE。
