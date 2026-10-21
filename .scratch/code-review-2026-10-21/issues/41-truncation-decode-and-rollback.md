# Issue 41: 趋势文本截断吞正文 + .lnk 删除吞错 + 解压回滚残留目录（10 残项）

Status: resolved
Priority: P2（正确性）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · Rust 健壮性分片

## 描述

10 号工单要求流式截断「返回前 2MB」并让清理失败可见，三处未达标：

1. `commands/network.rs:225-243`：按字节切到 `MAX_TRENDS_BYTES` 后再
   `String::from_utf8`，切点落在多字节字符中间时返回 `Err`——截断分支不返回正文，
   而是整段丢弃（中文场景概率不低）。
2. `commands/installer_uninstall.rs:108`：`let _ = remove_file(lnk)` 仍吞错（工单已点名）。
3. `installer/executor_portable.rs`：解压配额回滚只删文件，本次新建的目录残留。

## 修复方向

- 截断落字符边界后解码，保留前段有效正文；完整响应保持原错误路径。
- 清理失败上浮为 warn 日志（流程仍不可失败中断）。
- 回滚同时删本次新建的目录（只删空目录，预存内容不动）。

## Comments

- `network.rs` 新增 `decode_truncated_utf8`：`utf8_error().valid_up_to()` 截到边界再解码；
  截断日志仍是 `trends text truncated … bytes=`。
- `installer_uninstall.rs` 删除失败改 `log::warn!`（带路径与错误），流程保持 infallible。
- `executor_portable.rs`：`create_dir_all_tracked` 记录本次新建目录，`rollback_extracted`
  先删文件再最深优先 `remove_dir`；zip/tar 两条解压路径都接入。
- 回归：`truncation_cut_inside_multibyte_char_returns_valid_prefix`、
  `truncation_on_char_boundary_keeps_whole_text`、
  `rollback_removes_only_tracked_files_and_created_dirs`、
  `rollback_keeps_pre_existing_directories`。
- 验证：`cargo test` 378 过；`clippy -D warnings` 绿。
- 提交：e046c80。
