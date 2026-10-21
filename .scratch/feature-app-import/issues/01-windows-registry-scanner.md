# Issue 01: Windows 注册表与已装软件特征提取引擎

Status: resolved

## 描述

基于 Rust `winreg` 遍历已安装软件列表：
1. 读取注册表路径：
   - `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`
   - `HKLM\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall`
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`
2. 提取关键元数据结构体 `ScannedRawApp`：
   - `display_name`: 软件展示名称
   - `display_version`: 当前安装版本
   - `publisher`: 发布者名称
   - `install_location`: 安装目录
   - `display_icon`: 图标路径或主程序可执行文件
   - `uninstall_string`: 卸载命令
3. 过滤系统更新补丁、组件依赖（如 VC++ Redistributable、DirectX 等噪声项）。
4. 封装 Tauri IPC 命令 `scan_and_match_local_apps`。

## Comments

- `src-tauri/src/scanner.rs` 已实现 Windows 注册表三 Hive 扫描，支持 SystemComponent、KB 更新、ParentKeyName 过滤与名称去重。
- 非 Windows 平台条件编译回退空切片。

