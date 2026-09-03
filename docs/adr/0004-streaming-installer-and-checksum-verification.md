# ADR-0004: 流式安装引擎与零信任 SHA-256 完整性校验

- **状态**: Accepted
- **日期**: 2026-09-03
- **决策者**: 架构与安全团队

## 上下文

从第三方公共加速镜像下载二进制安装包存在中间人篡改或恶意投毒的风险。开源应用商店必须建立严密的零信任安全防线。

## 决策

1. **强制 SHA-256 流式校验**：
   - 安装引擎在分块下载网络流的同时实时计算 SHA-256 哈希值。
   - 文件下载完成后，必须与 GitHub 官方 Release 资产元数据或 `checksums.txt` / `SHA256SUMS` 中的官方预期指纹进行强校验。
   - 一旦哈希不匹配，立即无条件阻断安装、销毁临时文件，并通过 UI 警告弹窗报警，确保未经官方认证的文件绝不落地执行。
2. **多模式安装引擎**：
   - **Windows MSI**: 执行 `msiexec.exe /i <file> /qn` 静默安装，失败降级唤起向导。
   - **Windows Setup EXE**: 自动探测 NSIS (`/S`) 或 InnoSetup (`/VERYSILENT /NORESTART`) 参数。
   - **便携版 ZIP**: 自动安全解包至 `%LOCALAPPDATA%\Programs\z-store-apps\<app_id>\`，利用 PowerShell COM 组件自动在桌面建立快捷方式，并写入数据库以便后续无残留清理。
