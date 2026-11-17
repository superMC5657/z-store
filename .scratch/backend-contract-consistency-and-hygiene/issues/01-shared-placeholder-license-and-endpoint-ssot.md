# Issue 01: 占位元数据判定、协议归一与 GitHub 端点 URL SSOT 收敛

Status: needs-triage
Blocked by: none

## Summary

消除散落在多个后端模块中的占位字段判定、协议名归一与 GitHub 端点 URL 拼接重复代码，确保 `api_etag_cache` 键生成与元数据清洗口径严格一致。

## Scope

- Allowed to modify:
  - `src-tauri/src/github/http.rs` (或 `src-tauri/src/github/models.rs` / `src-tauri/src/github/mod.rs`)
  - `src-tauri/src/github/detail_fetch.rs`
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/github/search.rs`
  - `src-tauri/src/github/affinity_text.rs`
  - `src-tauri/src/github/discussions.rs`
  - `src-tauri/src/db/repo_cards.rs`
  - `src-tauri/src/db/custom_apps.rs`
  - `src-tauri/src/config.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src-tauri/src/commands/catalog_custom.rs`
  - `src-tauri/src/commands/updates_check.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **GitHub 仓库 / Release / README 端点构造 SSOT**：
   - 在 `github/mod.rs` 或 `github/http.rs` 收敛统一构造器（统一对 `owner` / `repo` 使用 `urlencoding::encode`）：
     - `github_repo_endpoint(owner: &str, repo: &str) -> String`
     - `github_latest_release_endpoint(owner: &str, repo: &str) -> String`
     - `github_readme_endpoint(owner: &str, repo: &str) -> String`
   - 替换 `catalog_detail.rs`（L302, L901, L905, L910）、`catalog_search.rs`（L331, L411, L1135）、`updates_check.rs`（L80, L565）、`detail_fetch.rs`（L718, L723, L841）、`detail_repo.rs`（L128）与 `search.rs`（L400）中的手写 `format!`。
2. **占位判定 SSOT**：
   - 将 `is_placeholder_description`（含 `"no description"` 统一口径）、`is_placeholder_version` 与 `is_placeholder_license` 统一收敛（如置于 `github/models.rs` 或 `models.rs` 共享辅助），让 `db/repo_cards.rs`、`commands/catalog_search.rs`、`github/detail_fetch.rs`、`github/catalog_service.rs` 共同调用，移除 `catalog_search.rs` 与 `repo_cards.rs` 的重复私有实现。
3. **协议归一、许可证解析、分类推断与门禁源对齐**：
   - 让 `db/custom_apps.rs::normalize_license` 与 `config.rs::normalize_license_token` 复用同一 `pub(crate) fn normalize_license_token` 函数。
   - `commands/catalog_custom.rs:380` 的 `save_custom_app` 改为传入 `&crate::db::custom_apps::resolve_license_gate()`，与同文件其余命令保持同源。
   - 收敛 `github/detail_fetch.rs:607-624` 与 `github/search.rs:58-76` 中重复的 GitHub 仓库 `license`（`spdx_id` / `key` 回退 `DEFAULT_LICENSE_ALLOWLIST`）解析为单一函数；评估将 `github/http.rs::guess_category` 与 `github/affinity_text.rs::CATEGORY_RULES` 合并为统一分类词表。
   - `github/discussions.rs:432-433, 549-552, 1100` 减少 `serde_json::Value` 整子树 `.cloned()`，改为直接借用引用字段。

## Acceptance Criteria

- [ ] 全仓不再存在未经过 `urlencoding::encode` 的手写 `/repos/{}/{}/releases/latest` 或 `/repos/{}/{}` URL 拼接。
- [ ] 占位描述/版本/协议判定及协议名归一仅保留单一实现并有单元测试覆盖。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
