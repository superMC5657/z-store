# Issue 04: Android 端移植预研与 Shizuku 静默安装插件方案

Status: resolved

## 描述

针对 Z-Store 未来的 Android 端原生移植进行深度预研，制定基于 Shizuku 服务的免 Root 静默安装技术架构方案：
1. 痛点分析：
   - 原生 Android 系统安装第三方 APK 每次都会强制弹出系统确认窗且必须人工逐一点击，无法满足多软件批量装机与静默后台更新诉求；
2. Shizuku 架构方案：
   - 依赖 Android 11+ 的无线调试授权或 ADB 配对启动 Shizuku 守护进程；
   - 利用 AIDL 与 Shizuku Client Binder 通信，获取 `android.permission.INSTALL_PACKAGES` 提权上下文；
   - 创建 `PackageInstaller.Session`，以流式传输 APK 文件并调用 `commit(statusReceiver)` 实现无感静默安装与版本覆盖；
3. Tauri 2 Android Plugin 设计：
   - 定义 Tauri 跨平台命令契约：`install_package_shizuku(apk_path: String) -> Result<(), String>`；
   - 编写完整的 Kotlin 伪代码与集成落地指导说明书。

## Comments

- 属于下一代移动端核心差异化技术基石。

## Answer

技术方案正文以 `docs/design/android-shizuku-research.md` 为准（本 issue 仅留结论指针，不复刻实现细节）：已完成基于 Shizuku 的免 Root 静默安装预研（UID 2000 握手 + `PackageInstaller.Session` 流式传输 + Tauri 2 Android 插件契约），结论 resolved。

