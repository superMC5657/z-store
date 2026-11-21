# Issue 09: 同步领域文档（`CONTEXT.md` / ADR 实现指针 / 索引）与全栈回归验收

Status: ready-for-agent
Blocked by: 05, 08

## Summary

在 `01`–`08` 全部合入后，校准仓库级领域文档、ADR 实现路径指针与 `.scratch/README.md` 索引，并执行完整跨端（Rust + React + Demo 构建）验收门禁，确保文档只陈述当前架构现状、不含变更流水账（遵守 `AGENTS.md`）。

## Scope

- Allowed to modify:
  - `CONTEXT.md`
  - `docs/adr/0015-unified-icon-fetch-and-search-alignment.md`（仅顶部或正文引用的模块路径已迁移处，如 `icons/` 世代协调器）
  - `docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md`（更新顶部 `实现：` 文件清单，纳入 `card_hydrator.rs` 等现行路径）
  - `docs/adr/0029-launchpad-social-discovery-and-isolated-manifest.md`（更新顶部 `实现：` 文件清单）
  - `.scratch/README.md`
  - `.scratch/module-deepening-v2/spec.md`
- Do not modify:
  - 业务逻辑代码（除非全量门禁发现遗漏的 lint / 注释清理问题）

## Implementation Details

1. **同步 `CONTEXT.md` 现状描述**：
   - 检查 D2 / D5 / D10 条目中涉及 `CatalogService`、`repositories/`（`DetailRepository` + `CardHydrator`，移除已删除的 `CatalogRepository`）、无令牌清单同步池与 `icons/` 世代流协调的路径说明，确保与重构后的模块职责精确一致；描述聚焦当前行为，不写历史对比。
2. **校准关联 ADR 的实现路径索引**：
   - 更新 ADR-0015、ADR-0027、ADR-0029 中指向旧命令内部辅助（如 `commands/catalog_search.rs::save_and_emit`）的路径引用至新模块位置，保持既有架构决策语义不变。
3. **更新 `.scratch/README.md` 与 `spec.md` 状态**：
   - 将 `.scratch/README.md` 中 `#40 · module-deepening-v2` 状态更新为 `9 / 9 Resolved`，并在阶段演进摘要中补充简明定位。
4. **执行全栈验收门禁**：
   - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
   - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
   - `cargo test --manifest-path src-tauri/Cargo.toml`
   - `pnpm test`
   - `pnpm build`

## Acceptance Criteria

- [ ] `CONTEXT.md` 与关联 ADR 中的文件路径引用均真实存在于当前代码库（无已删除的 `catalog_repo.rs` 等悬空路径），且文档风格符合 `AGENTS.md`（描述现状，不记变更历史）。
- [ ] `.scratch/README.md` 与 `.scratch/module-deepening-v2/spec.md` 状态全部对齐。
- [ ] `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`pnpm test`、`pnpm build` 全部零警告、零失败通过。
