# Issue 01: 后端开源广场投稿预检探测引擎与 `preflight_launchpad_submission` IPC

Status: resolved
Blocked by: none

## Summary

扩展 `ForgeRepoInfo` 以携带源仓库 SPDX 开源协议与作者头像 URL，并在后端实现无服务端依赖的开源广场投稿预检命令 `preflight_launchpad_submission`，一次性校验仓库坐标合法性、查重状态、OSI 协议门禁（37 项 SPDX 白名单）、最新 Release 资产/平台推导以及图标探测效果。

## Scope

- Allowed to modify:
  - `src-tauri/src/forge/provider.rs`（`ForgeRepoInfo` 新增 `license: Option<String>` 与 `owner_avatar_url: Option<String>`）
  - `src-tauri/src/forge/github.rs`、`src-tauri/src/forge/gitea.rs`、`src-tauri/src/forge/gitlab.rs`（提取仓库 `license` SPDX 与作者头像字段）
  - `src-tauri/src/launchpad/models.rs`（定义 `PreflightCheckItem` 与 `LaunchpadPreflightResult`）
  - `src-tauri/src/launchpad/mod.rs`（实现可测试的预检决策纯函数：协议门禁判定、资产平台统计、重复检测）
  - `src-tauri/src/commands/launchpad.rs`（新增 `preflight_launchpad_submission` 命令）
  - `src-tauri/src/commands/launchpad_tests.rs`（补充预检单测）
  - `src-tauri/src/lib.rs`（注册 `commands::preflight_launchpad_submission`）
- Do not modify:
  - `src/` 前端文件（在 Issue 02 / 03 处理）
  - `src-tauri/src/db/custom_apps.rs`（不混入本地草稿写表，预检只读不写库）

## Implementation Details

1. **`ForgeRepoInfo` 协议与头像字段扩展（`src-tauri/src/forge/`）**：
   - `ForgeRepoInfo` 增加 `pub license: Option<String>` 和 `pub owner_avatar_url: Option<String>`（`from_counts` 保持兼容并在各 provider 填充或新增辅助构造）。
   - GitHub 读取 `license.spdx_id` 与 `owner.avatar_url`；Codeberg/Gitea 与 GitLab 按各自 JSON 响应尽力提取（缺失则为 `None`）。
2. **`preflight_launchpad_submission` 异步命令（`src-tauri/src/commands/launchpad.rs`）**：
   - 参数签名：
     ```rust
     #[tauri::command(rename_all = "camelCase")]
     pub async fn preflight_launchpad_submission(
         state: State<'_, AppState>,
         repo_url: String,
         custom_icon_url: Option<String>,
     ) -> crate::AppResult<LaunchpadPreflightResult>
     ```
   - 预检逻辑：
     1. **坐标解析**：`RepositoryUrlParser::parse(&repo_url)` + `canonical_app_id`；若无法识别仓库地址，返回 `ok = false` 与 `checks = [{ key: "coord", status: "fail", ... }]`；
     2. **重复检测**：检查 `state.catalog.is_cataloged(&canonical_id)`（置 `already_in_catalog`）及本地 `launchpad_feed_cache` 快照 `items` 是否已存在（置 `already_in_launchpad`），若存在则添加 `status: "warn"` 检查项（不硬阻塞，提示作者当前位置）；
     3. **仓库元信息与 OSI 协议校验**：并发拉取 `ForgeRegistry::fetch_repo` 与 `ForgeRegistry::fetch_latest_release`（GitHub 携带活跃 Token；非 GitHub 取 `host_tokens`）；使用 `LicenseGateConfig::default()`（强制 37 项 OSI 白名单）结合 `normalize_license_token` 校验 `license`；
     4. **Release 与平台推导**：调用 `crate::github::detail_assets::is_valid_installer_asset` 统计 `installable_asset_count`、调用 `lite_platforms_for_github_assets`（复用到通用资产切片）推导 `platforms`，并检查资产中是否含校验清单文件；若无任何有效构建资产则标记 `release` 为 `fail`；
     5. **图标验证**：
        - 若传 `custom_icon_url`：必须通过 `https://` 校验且无 `data:`，经无 Token CDN 池按 D8 读取首包并调用 `icons::sniff_image_mime` 验证为合法图片；
        - 否则调用 `icons::probe_single_live`（或探测分支默认头像/logo 候选）获取可用图标 URL；若均未命中，标记 `icon` 为 `warn`（提示建议在项目根目录放 logo 或提供自定义图标 URL）。

## Acceptance Criteria

- [x] Rust 单测验证各门禁组合：
  - MIT + 含 `.exe`/`.AppImage` Release 资产 → `ok == true`、正确推导 `platforms`；
  - `NOASSERTION` 或闭源/非 OSI 协议（如 `BUSL-1.1`）→ `license` 检查项 `fail` 且 `ok == false`；
  - 无任何有效安装包资产 → `release` 检查项 `fail` 且 `ok == false`；
  - 非 `https://` 的 `custom_icon_url` 被拒绝。
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
