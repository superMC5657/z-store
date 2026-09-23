# ADR-0004: 流式安装引擎与零信任 SHA-256 完整性校验

- **状态**: Accepted
- **日期**: 2026-09-03
- **决策者**: 架构与安全团队

## 上下文

从第三方公共加速镜像下载二进制安装包存在中间人篡改或恶意投毒的风险。开源应用商店必须建立严密的零信任安全防线。

## 决策

1. **强制 SHA-256 流式校验与零信任状态判定**：
   - 安装引擎在分块下载网络流的同时实时计算 SHA-256 哈希值。
   - 文件下载完成后，若 Release 资产或 `checksums.txt` / `SHA256SUMS` 提供了官方预期哈希，必须进行强制比对：一旦哈希不匹配，立即无条件阻断安装、销毁临时文件并向前端告警；
   - 若上游官方未发布任何校验哈希，流式哈希仍会计算并持久化至本地数据库以备审计，但事件状态必须明确标识为未校验（`completed_unverified`），禁止向用户虚假声明“已通过官方校验”。
2. **应用内仅下载模式（`download_asset`）**：
   - 宿主原生不可安装的资产类型（如 Windows 下的 `msixbundle` / `other`）不再跳系统浏览器，复用同一镜像改写、流式下载、SHA-256 校验与 `zstore://download-progress` 进度通道，仅下载落盘至用户下载目录，不调用任何安装器；
   - 落盘后经 `show_file_in_folder` / `open_folder` 调起系统文件管理器定位文件（Windows `explorer /select`、macOS `open -R`、Linux 打开父目录）。
3. **多平台安装引擎与系统提权规范**：
   - **Windows MSI**: 执行 `msiexec.exe /i <file> /qn` 静默安装，失败降级唤起向导；静默与向导两次调起均带 `MSIFASTINSTALL=7` 环境变量，跳过系统还原点创建（高频安装场景下每个还原点动辄十几秒），仅作用于本次拉起的进程，不改系统全局策略。
   - 安装成功后固定等待 800ms 让系统落盘（注册表/文件写入，仅安装侧；卸载侧等待不变），再嗅探安装路径；外部向导异步落盘导致的路径晚到，由既有的 5×500ms 重试循环兜底。
   - **Windows Setup EXE**: 自动探测 NSIS (`/S`) 或 InnoSetup (`/VERYSILENT /NORESTART`) 参数。
   - **便携版 ZIP**: 自动安全解包至 `%LOCALAPPDATA%\Programs\z-store-apps\<app_id>\`，利用 PowerShell COM 组件自动在桌面建立快捷方式，并写入数据库以便后续无残留清理。
   - **macOS DMG**: 执行 `hdiutil attach -nobrowse -readonly` 挂载 -> 探测卷内 `.app` 目录 -> 拷贝至 `/Applications`（无写权限时降级为 `~/Applications`）-> 强制调用 `hdiutil detach -force` 卸载释放卷。
   - **macOS PKG**: 优先通过 `installer -pkg <path> -target CurrentUserHomeDirectory` 或唤起系统 `open` 安装向导。
   - **Linux AppImage**: 执行 `chmod +x` 赋予可执行权限后直接启动，无需提权。
   - **Linux DEB / RPM**: 通过系统标准 `pkexec dpkg -i` / `pkexec rpm -i` 触发 PolicyKit 图形化提权交互，向用户清晰告知授权意图。
