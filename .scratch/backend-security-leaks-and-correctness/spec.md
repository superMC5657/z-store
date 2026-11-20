# Feature Spec: 安装器安全加固、异步取消资源泄漏防护与更新规则/扫描健壮性

> 状态：Implemented（`01`、`02`、`03` 均为 `resolved`）
> 关联契约：`CONTEXT.md`（D3 零信任防篡改、`Portable App`、`Update Rule`、`External App Management`）、ADR-0004（流式安装与校验和验证）、ADR-0028（倒排索引与边界安全的本地应用匹配）。

---

## 1. 问题背景与根因诊断

对 `installer/`、`scanner/`、`commands/` 与 `Cargo.toml` 深度审查后，发现以下安全性、异常/取消路径资源泄漏及正确性隐患：

### 1.1 安全与输入校验缺口
- **PowerShell 单引号绕过注入风险（`src-tauri/src/installer/paths.rs:186-196`）**：`create_desktop_shortcut` 通过字符串拼接构造 PowerShell `-Command`，仅转义 ASCII `'`（`.replace('\'', "''")`）；但 PowerShell 将 Unicode 智能引号（`‘`/`’`/`‚`/`‛`）同样视为字符串定界符，而 `exe_path` 来自归档内解压出的 `.exe` 文件名。
- **便携包解压炸弹与软链绕过（`src-tauri/src/installer/executor_portable.rs:88-121, 165-252`、`executor_macos.rs:112-120`）**：
  - `install_portable_zip`（L104–114）与 `unpack_tar_entries`（L224–236）在拷贝前仅检查归档头声明大小，随后执行无上界 `io::copy` 落盘后才复核字节数；伪造小头部声明可先耗尽磁盘。
  - `unpack_tar_entries` 仅在常规文件分支调用 `check_extract_quota`，海量目录/软链条目不受 `MAX_EXTRACT_ENTRIES` 限制；`install_portable_zip` 未过滤 `file.is_symlink()`；`executor_macos.rs:115` 使用 `path.is_dir()` 会跟随 DMG 内符号链接。
- **命令层参数校验绕过（`commands/settings.rs:102-122`、`commands/system.rs:92-160`、`commands/catalog_search.rs:907-918`）**：
  - `save_setting("active_mirror", "http://...")` 可绕过 `switch_mirror` 的 `validate_custom_proxy`（`https://` 强制校验）。
  - `open_desktop_path` 未拒绝 UNC 网络路径（`\\...`）；`enrich_targets` 仅 `trim()` 未校验坐标段合法性。

### 1.2 异步取消导致的资源泄漏与异常回滚缺失
- **下载 `.tmp` 残留（`installer/downloader_http.rs:195-238`）**：下载 Future 被取消/drop 时，`tmp_path` 不会自动清理。
- **Win32 进程句柄泄漏与卸载命令解析缺陷（`installer/executor_uninstall.rs:4-46, 168-240`）**：`SendHandle(HANDLE)` 未实现 `Drop`，在 `tokio::time::sleep` 期间取消会泄漏进程句柄；`WaitForSingleObject(launched.0, 250)` 直接运行在 async 线程；`parse_uninstaller_command` 遇到无引号含空格路径（如 `C:\Program Files\App\unins.exe /S`）按首个空格拆分成 `"C:\Program"` 导致卸载调起失败，且 `split_whitespace()` 会拆散带引号参数。
- **macOS DMG 挂载点泄漏（`installer/executor_macos.rs:131-164`）**：`hdiutil attach` 成功后若后续步骤报错提前返回，未执行 `hdiutil detach`。
- **解压异常中断未回滚（`installer/executor_portable.rs`）**：`rollback_extracted` 仅在配额超限时调用，遇到归档损坏或写入失败直接 `?` 返回，残留半成品文件与目录。

### 1.3 更新规则静默丢弃、README/扫描局部性能与构建配置
- **DB 失败吞错导致更新规则/隐藏规则失效（`commands/updates_check.rs:306, 479, 668`、`commands/catalog_search.rs:169-180`）**：`db.get_all_rules().unwrap_or_default()` 在锁失败或 DB 错误时静默丢失全部冻结/跳过/隐藏策略。
- **局部热路径与构建配置（`github/markdown.rs:250-301`、`scanner/registry.rs:209-228`、`scanner/executable.rs:436-532`、`Cargo.toml`）**：`markdown.rs` 循环内编译 `Regex::new` 且全篇 `.lines().collect()`；`registry.rs::is_path_covered` 为 $O(S \times N)$；`Cargo.toml` 缺 `[profile.release]` 优化且 `tokio` 开启 `full`。

---

## 2. 优化目标与设计方案

1. **安装器与命令边界安全加固（Issue 01）**：PowerShell 快捷方式改用 `-EncodedCommand`（UTF-16LE Base64）或环境变量传参；解压 `io::copy` 加 `Read::take(remaining + 1)`、全条目计数、ZIP/DMG 软链过滤及全异常路径回滚；补齐 `save_setting` / `open_desktop_path` / `enrich_targets` 校验。
2. **RAII 资源清理与卸载解析修复（Issue 02）**：为 `tmp_path`、Win32 `SendHandle` 与 macOS DMG 挂载点添加 `Drop` RAII 守卫；修复无引号含空格卸载命令与带引号参数解析；`WaitForSingleObject` 移出 async 线程。
3. **规则错误传播、扫描器/Markdown 算法与 Cargo 构建优化（Issue 03）**：`get_all_rules()` 等规则读取不再静默降级为空集；`markdown.rs` 静态化正则与惰性切片；`scanner/registry.rs` 预建 `HashSet` 降为 $O(S+N)$；精简 `tokio` 特性并配置 `[profile.release]`。

---

## 3. 实施 Issue 拆分清单

- [`01-installer-injection-and-archive-bomb-hardening.md`](./issues/01-installer-injection-and-archive-bomb-hardening.md)
- [`02-async-cancel-resource-leaks-and-uninstaller-parsing.md`](./issues/02-async-cancel-resource-leaks-and-uninstaller-parsing.md)
- [`03-rules-error-propagation-scanner-and-build-hygiene.md`](./issues/03-rules-error-propagation-scanner-and-build-hygiene.md)
