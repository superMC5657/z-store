# Issue 42: 429 口径与 URL 编码只修了一半（14/15 残项）

Status: resolved
Priority: P2（网络正确性）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · Rust 网络分片

## 描述

14 号（URL 编码与宿主判定）与 15 号（限流口径）各只闭合一半：

- Retry-After 仅在 `github/http.rs:72-83` 消费；`gitea.rs`/`gitlab.rs` 只补了配额上报，
  抓取仍是单发零处理，「三家不一致」原样。
- `matches_host` 不剥端口，`https://github.com:443/o/r` 落成 gitea；注释却称与
  `mirror::host_is_or_subdomain_of` 同口径（后者喂的是剥过端口的 host）。
- `valid_coord_segment` 对 owner/repo 也放行 `:`，与 `forge:host:owner/repo` 语法相撞。
- 漏编点：`readme_fetch.rs:208`（`?ref=`）、`:341`（raw 直取）、`icon_probe.rs:472`、
  `detail_fetch.rs:66/513/625`、`icons_cycle_probe.rs:440`。
- `commands/forge.rs:93,198` 仍手写 `ends_with(".github.com")`，绕过新 SSOT。
- `icon_probe.rs:460-465` 两段 doc 被删空行焊在一起，「Trees 探测分支」描述错了函数。

## 修复方向

- 抽共享 `retry_after_delay_ms` + `get_with_retry_after_once`，两家 forge 全请求点接入。
- 宿主比较剥端口/结尾点；owner/repo 段拒绝 `:`，host 段放行。
- 所有拼 URL 的坐标段统一 percent-encoding；宿主判定统一走 `ForgeType::matches_host`。
- doc 块拆回各自函数。

## Comments

- `forge/http.rs` 新增 `pub(crate) retry_after_delay_ms`（60s 上限 / 5s 缺省）与
  `get_with_retry_after_once`（429 → 夹紧 sleep → 重发一次）；`github/http.rs` 改引用；
  `gitea.rs`/`gitlab.rs` 全部请求点接入。5xx/传输错误明确不重试。
- `forge/coord.rs`：`matches_host` 剥 `:port` 与结尾点；新增 `normalize_url_host` 归一 Web URL
  host（https 443 / http 80 折叠）；`valid_host_segment`（放行 `:`）与 `valid_repo_segment`
  （拒绝 `:`）分家。
- `readme_fetch.rs` 新增 `encode_path_segments` 并覆盖 contents 与 raw 两处；`icon_probe.rs`、
  `detail_fetch.rs`、`icons_cycle_probe.rs` 同步编码。
- `commands/forge.rs` 两处宿主判定改 `ForgeType::GitHub.matches_host`。
- 回归：`test_matches_host_ignores_port_and_trailing_dot`、
  `test_parse_url_host_default_port_and_trailing_dot`、`test_parse_rejects_colon_in_owner_repo`、
  `retry_after_delay_ms_clamps_and_defaults`。
- 验证：`cargo test` 378 过；`clippy -D warnings` 绿。CONTEXT D7 / ADR-0012 同步 429 口径。
- 提交：e046c80（文档 71582c0）。
- 遗留：`Retry-After` 的 HTTP-date 形态仍按缺省 5s（仓库无日期解析依赖，未新增 crate，
  已在 helper doc 写明）。
