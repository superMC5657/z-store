# Issue 03: macOS 与 Linux 原生安装器执行管道落地

Status: resolved

## 描述

在 `installer.rs` 中落地跨平台（macOS / Linux）发布包原生执行管道：
1. macOS 原生安装管道：
   - `.dmg`: 支持 `hdiutil attach -nobrowse -readonly` -> 扫描挂载点查找 `.app` 目录 -> 拷贝至 `/Applications` 或便携目录 -> `hdiutil detach`；
   - `.pkg`: 生成并执行 `installer -pkg <path> -target CurrentUserHomeDirectory`；
2. Linux 原生安装管道：
   - `.AppImage`: 赋予执行权限 `chmod +x` -> 移动至 `~/.local/bin` 或便携目录 -> 自动生成并写入 `~/.local/share/applications/{app_id}.desktop`；
   - `.deb`: 生成 `pkexec dpkg -i <path>` 安装命令；
   - `.rpm`: 生成 `pkexec rpm -i <path>` 安装命令；
3. 通用管道执行构建：
   - 提取跨平台通用执行参数与测试 Mock 运行；
   - 编写单元测试验证各平台命令与参数组装正确性。

## Comments

- 为未来 Linux 与 macOS 官方 CI 发布打下坚实底层。

## Answer

已落地 macOS 与 Linux 多端原生安装器执行管道：
1. `AssetKind` 与 `classify_asset` 扩展支持 `.dmg`、`.pkg`、`.deb`、`.rpm`、`.appimage` 与 `.apk` 及 `portable_tarball`（.tar.gz/.tgz/.tar.xz/.tar）；
2. 实现了跨平台通用管道命令生成器 `InstallerEngine::build_unix_install_commands`，覆盖 macOS `hdiutil` / `installer` 与 Linux `chmod` / `pkexec dpkg` / `pkexec rpm`；
3. 在 `execute_installation` 中集成 macOS/Linux 原生调用与平台回退保护；
4. 单元测试 `installer::tests::test_build_unix_install_commands` 验证通过。

