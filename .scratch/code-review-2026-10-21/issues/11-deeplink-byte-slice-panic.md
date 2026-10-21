# Issue 11: deeplink 字节切片非字符边界 panic

Status: resolved
Priority: P2（健壮性/崩溃）
来源: 2026-10-21 全项目审查 · Rust 安全分片

## 描述

`src-tauri/src/deeplink.rs:28` 用 `s[..9]` 按字节切前缀。`handle_deep_link` 收到如
`zstore:/é`（第 9 字节落在多字节 UTF-8 字符中间）时 panic——畸形深链即可让进程崩溃，
属于外部输入直达的 DoS 面。

## 修复方向

- 改 `s.get(..9)` + 比较，或直接 `s.starts_with("zstore://")`（借用检查友好且无 panic）。
- 附带对深链整体长度与百分号编码内容加防御性校验。

## Comments

- **前缀切片防 panic**：`DeepLinkParser::parse` 改 `s.get(..9).is_some_and(|p|
  p.eq_ignore_ascii_case("zstore://"))`：第 9 字节落在多字节 UTF-8 字符中间时 `get`
  返回 None、按不匹配拒绝，畸形深链不再崩进程；大小写不敏感前缀语义保留
  （`ZSTORE://…` 照常解析）。
- **防御性校验**（附带项）：整链长度上限 `MAX_DEEPLINK_LEN = 2048`，超长直接拒绝；
  新增 `decode_payload` 统一五个解码点——解码失败回退原串的既有语义不变，解码结果含
  NUL（`%00` 注入面）视为畸形载荷整链拒绝。
- **测试**：新增 3 个单测锁定边界（多字节前缀不 panic + 大写前缀放行、超长拒绝、
  NUL 拒绝 + 非法编码回退保留）。
- **验证**：`cargo test` 347 通过；`cargo clippy -- -D warnings` 无来自本文件的告警。
  本单 Rust 侧为独立修复，无前端行为联动（深链路由动作不变）；vitest 全量 733 通过。
