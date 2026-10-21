# Issue 04: 镜像并发测速与 SHA-256 防篡改安装引擎

Status: resolved

## 描述

实现中国网络加速与跨平台安装引擎：
1. 镜像管理模块：支持 `gh-proxy.com`、`gitmirror.com` 等节点，实现异步并发并发测速与动态故障转移；
2. 资产识别：自动将 Release assets 归类为 MSI、EXE、便携 ZIP、便携Tarball（二进制tar.gz等os+arch放行）、Deb、RPM、PKG、AppImage、APK、DMG，`.7z`/`.tar.bz2`/源码包归Other；
3. 下载与防篡改：分块流式下载并实时推送事件，强制比对官方 SHA-256 哈希，不符立即阻断并销毁；
4. Windows 执行：MSI `/qn` 静默安装、EXE 静默参数；便携版（ZIP/Tarball，tarball剥顶层+chmod兜底）解压至 AppData 并生成桌面快捷方式；卸载清理引擎。

## Comments

- `src-tauri/src/mirror.rs` 支持多线路并发测速与链接重写。
- `src-tauri/src/installer.rs` 实现 SHA-256 流式计算与防篡改硬校验，Windows MSI/便携解压与快捷方式生成，单测全部通过。
