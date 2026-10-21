# Issue 14: forge 路径 URL 编码缺失与宿主判定过宽

Status: resolved
Priority: P2（正确性/注入面）
来源: 2026-10-21 全项目审查 · Rust 架构分片

## 描述

owner/repo/分支未 URL 编码直拼 API 路径，可造成路径/查询注入与错误端点：

1. `src-tauri/src/forge/github.rs:26,84`、`src-tauri/src/forge/gitea.rs:35,95`（GitLab
   已编码，可作为参照实现）。
2. `src-tauri/src/forge/coord.rs:119`：coord 解析对 owner 保留 `?`/空格；`coord.rs:86`
   total 回退同理。
3. `src-tauri/src/github/search.rs:66-76,212`：直查 owner/repo 未编码/未校验即入 URL。
4. `src-tauri/src/github/icon_probe.rs:226-233`：raw_url 的 branch/path 未编码，含 `/`
   的分支名即错。
5. `src-tauri/src/commands/forge.rs:96,142`：`contains("github.com")` 判宿主，
   `xx-github.com` 误入 GitHub 分支；:191 gitea 分支 host 未校验直拼 URL。

## 修复方向

- 统一在 coord 解析出口做严格校验（拒绝 `?`/空格/`#`/`/` 于 owner 与 repo 段），拼 URL
  前统一 `utf8 percent-encoding`（对齐 gitlab.rs 现有写法）。
- 宿主判定改解析后精确匹配（`host == "github.com"` 或白名单后缀匹配）。

## Comments

- **coord.rs 解析出口**：新增 `valid_coord_segment`（拒绝空段与 `?`/`#`/`/`/`\`/空白；
  host 放行 `:` 供非标端口）+ `checked_coord` 唯一构造点，四条解析分支全部收口，
  脏段整体返回 `None` 由调用方拒绝。`canonical_app_id_from_parts`（:86）total 回退保持原样：
  其契约是永不失败（既有单测锁定 `"o"/"r r" → "o/r r"`），产物仅作 DB 键不入 URL；
  解析出口收紧后脏输入不再产出 coord，注入面已在 parse exit + URL 编码双层关闭。
- **宿主判定**：`ForgeType::matches_host`（精确 + `.domain` 子域白名单，与
  `mirror::host_is_or_subdomain_of` 同口径）替换 URL 分支三处 `contains` 及
  commands/forge.rs 两处 `contains("github.com")`；`xx-github.com`/`github.com.evil.com`
  回落 Gitea，`api.github.com` 仍命中 GitHub。
- **URL 编码**：forge/github.rs（repos、releases/latest）、forge/gitea.rs（同两处）、
  github/search.rs `fetch_online_repo` 直查 URL 统一 `urlencoding::encode(owner/repo)`；
  github/icon_probe.rs `raw_url` owner/repo/branch 整段编码（含 `/` 分支名成 `%2F`）、
  path 保留 `/` 逐段编码（对齐 markdown.rs 写法）。
- **commands/forge.rs :191**：新增 `valid_self_hosted_host`（拒空/scheme/`/?#\`/空白），
  `test_host_connection` 对脏 host 直接返回未连接状态，不再直拼 `https://{host}/api/v1/version`。
- **测试**：forge/tests.rs 新增 `test_matches_host_exact_or_subdomain_not_substring`、
  `test_parse_rejects_injectable_segments`、`test_parse_host_detection_exact_not_substring`；
  cargo test 354 全绿，`cargo clippy -- -D warnings` 干净。
- 备注：`cargo clippy --all-targets` 另报 scanner/executable.rs:1720 测试代码
  `useless_vec`，系基线提交 87c0afe 自带（非本批文件），未越界处理。
