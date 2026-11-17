# Issue 01: 安装器脚本注入防护、解压炸弹硬限与命令参数校验收口

Status: needs-triage
Blocked by: none

## Summary

消除便携包解压配额绕过、软链逃逸、PowerShell 快捷方式 Unicode 引号注入风险，并对齐命令层参数校验（镜像配置、UNC 路径、趋势 enrich 坐标）。

## Scope

- Allowed to modify:
  - `src-tauri/src/installer/paths.rs`
  - `src-tauri/src/installer/executor_portable.rs`
  - `src-tauri/src/installer/executor_macos.rs`
  - `src-tauri/src/commands/settings.rs`
  - `src-tauri/src/commands/system.rs`
  - `src-tauri/src/commands/catalog_search.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **PowerShell 快捷方式防注入 (`installer/paths.rs:186-196`)**：
   - `create_desktop_shortcut` 不再将文件名与路径直接拼接进 `-Command` 单引号字符串。
   - 改为使用固定静态 PowerShell 脚本读取进程环境变量（如 `ZSTORE_LNK_NAME` / `ZSTORE_LNK_TARGET` / `ZSTORE_LNK_WORKDIR`）或经 `-EncodedCommand`（UTF-16LE Base64）传入，彻底消除 Unicode 智能引号（`‘`/`’` 等）或特殊字符绕过。
2. **解压炸弹硬限制、软链防护与全异常回滚 (`installer/executor_portable.rs` & `executor_macos.rs`)**：
   - `install_portable_zip` 与 `unpack_tar_entries` 在 `io::copy` 时使用 `(&mut reader).take(remaining + 1)` 限制实际拷贝字节，严禁仅靠归档头声明大小放行无界写入；拷贝超限立即触发 `rollback_extracted`。
   - `unpack_tar_entries` 在循环顶部（过滤目录/软链前）统一校验 `entries_seen <= MAX_EXTRACT_ENTRIES`。
   - `install_portable_zip` 跳过符号链接条目（`file.is_symlink()` 或 Unix mode `S_IFLNK`）；`executor_macos.rs:115` 使用 `std::fs::symlink_metadata(&path)` 确认 `.app` 非符号链接。
   - `install_portable_zip` 与 `unpack_tar_entries` 在 `create_dir_all_tracked`、`by_index`、`File::create`、`io::copy` 等任意错误路径返回前一律调用 `rollback_extracted(&written, &created_dirs)`，且不吞掉 `create_dir_all_tracked` 的 `Err`。
3. **命令层校验收口**：
   - `commands/settings.rs::save_setting`：当 `key == "active_mirror"` 时调用 `crate::mirror::validate_custom_proxy(&value)`；当 `key == "catalog_source_url"` 时限制合法 URL/已配置路径形态（或拒绝危险协议）。
   - `commands/system.rs::open_desktop_path`：Windows 下拒绝 UNC 网络路径（`\\...` / `\\?\UNC\...`），防止触发 SMB/NTLM 凭据外泄。
   - `commands/catalog_search.rs::enrich_targets`：校验 `owner`/`repo` 非空且不含 `/`、空白或控制字符（复用 `canonical_app_id_from_parts` 合法性口径）。

## Acceptance Criteria

- [ ] 伪造小声明大小但实际超配额的 ZIP/Tar 包在解压写入达到阈值时立即中止并回滚，不会写满磁盘。
- [ ] `create_desktop_shortcut` 不存在任何基于路径字符串的 PowerShell 脚本拼接。
- [ ] 补齐单元测试覆盖：伪造头大小 ZIP/Tar 拦截与回滚、`active_mirror` 经 `save_setting` 的 HTTPS 校验、UNC 路径拒绝。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
