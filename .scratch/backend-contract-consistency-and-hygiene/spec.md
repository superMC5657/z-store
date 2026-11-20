# Feature Spec: 后端元数据校验与端点 SSOT 收敛、错误边界与局部性能细节清理

> 状态：Implemented（`01`、`02` 均为 `resolved`）
> 关联契约：`CONTEXT.md`（`Unified Project Config`、`Canonical App Id`、`ETag Cache`）、ADR-0010（规范应用标识）、ADR-0018（开源协议门禁可配置）。

---

## 1. 问题背景与根因诊断

在全局静态检查中，还发现若干跨模块规则漂移、重复构造与边界细节：

### 1.1 占位字段判定、协议归一与 GitHub 端点 URL 构造存在多处重复与细微漂移
- **占位字段判定分散（`db/repo_cards.rs:151-189`、`commands/catalog_search.rs:226-233, 305-308`、`github/detail_fetch.rs:39-57`、`github/models.rs`）**：
  - `is_placeholder_description` 在 `detail_fetch.rs` 定义，而 `db/repo_cards.rs` 又外包了一层 `is_placeholder_text` 追加 `"no description"`；`is_placeholder_license` 与 `is_placeholder_version` 在 `commands/catalog_search.rs` 和 `db/repo_cards.rs` 各自实现，且与 `CatalogItem::is_concrete_license` / `is_concrete_version` 规则重叠。
- **协议名归一重复（`config.rs:474-483` vs `db/custom_apps.rs:40-49`）**：
  - `normalize_license_token` 与 `normalize_license` 为逐字等价的重复函数。
- **GitHub API URL 编码不一致（`catalog_detail.rs:302-305, 901-904`、`updates_check.rs:80-83`、`catalog_search.rs:331-334` vs `detail_fetch.rs:718-727`、`search.rs:400-404`）**：
  - 部分调用点手写 `format!("https://api.github.com/repos/{}/{}/releases/latest", owner, repo)` 未经 `urlencoding::encode`，而另一部分调用点经过 `urlencoding::encode`，与 `api_etag_cache` 键复用存在潜在漂移风险。
- **`save_custom_app` 门禁传入来源不一致（`commands/catalog_custom.rs:380`）**：
  - `save_custom_app` 传入 `&LicenseGateConfig::default()`，而同文件 `get_custom_app_pr_url` / `get_custom_app_pr_payload` / `get_license_allowlist` 使用 `resolve_license_gate()`。

### 1.2 命令错误边界不统一、设置键白名单每键分配整张 `HashMap`、启动降级可见性不足
- **设置键检查高频堆分配（`src-tauri/src/commands/settings.rs:5-54`）**：
  - `is_managed_setting_key(key)` 每次调用都执行 `get_default_settings().contains_key(key)`，分配并填充一个含 18 个 `String` 键值对的 `HashMap` 后立即丢弃。`get_settings` 对 `db_settings` 逐条循环调用该函数，单次调用即可产生数百次无效堆分配。
- **命令返回类型不统一（`commands/catalog_feed.rs:263`、`commands/network.rs:239`、`commands/catalog_detail.rs:673`）**：
  - `get_home_feed`、`fetch_trends_text` 等仍返回 `Result<_, String>`，未统一使用 `crate::AppResult<T>`。
- **外部清单/启动降级审计（`repositories/catalog_repo.rs:17`、`lib.rs:345-350`）**：
  - `CatalogRepository::seed_from_config_if_empty` 调用 `load_catalog_items().unwrap_or_default()` 静默吞掉 JSON 解析错误；`lib.rs` 数据库打开失败退化为内存模式时，无状态查询标识供前端提示用户当前处于临时内存数据库。

---

## 2. 优化目标与设计方案

1. **元数据清洗、协议归一与端点 URL SSOT 收敛（Issue 01）**：
   - 将占位描述/版本/协议判定、协议归一函数（`normalize_license`）与 GitHub 仓库/Release 端点 URL 构造收敛为单一真相源（SSOT），消除重复与编码漂移；`save_custom_app` 统一使用 `resolve_license_gate()`。
2. **设置白名单零分配、错误边界统一与启动降级可观测性（Issue 02）**：
   - `commands/settings.rs` 改用静态常量 `&[&str]` 校验白名单并在单测中锁定与 `get_default_settings()` 键集完全同步；命令出口统一收敛至 `crate::AppResult<T>`；为 `seed_from_config_if_empty` 补充解析失败告警日志与启动 DB 降级诊断标记。

---

## 3. 实施 Issue 拆分清单

- [`01-shared-placeholder-license-and-endpoint-ssot.md`](./issues/01-shared-placeholder-license-and-endpoint-ssot.md)
- [`02-error-boundary-and-settings-key-allocation-cleanup.md`](./issues/02-error-boundary-and-settings-key-allocation-cleanup.md)
