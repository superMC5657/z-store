# Issue 01: 核心工程脚手架与 Tauri 2 运行时配置

Status: resolved

## 描述

初始化 Z-Store 核心工程基座：
1. 配置根目录 `package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`，引入 React 19、TypeScript 5.7 与 Vite 6；
2. 配置 `src-tauri/Cargo.toml`、`build.rs`、`tauri.conf.json`、`capabilities/default.json`；
3. 支持无边框拖拽、窗口控制与 Updater 插件。

## Comments

- 已完成根目录脚手架与 Tauri 2 核心配置。
- 前端支持 Vite 6 + React 19 + TypeScript。
- Windows 11 无边框透明窗口与权限能力配置完毕。
