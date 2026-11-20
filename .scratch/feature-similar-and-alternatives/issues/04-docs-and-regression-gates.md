# Issue 04: 文档同步、ADR 补充与全量回归门禁

Status: resolved
Blocked by: 03

## Summary

完成特性 #37 的领域文档与架构决策补充，并执行全量 Rust 与前端测试、类型检查、规范门禁与 Demo 构建校验。

## Scope

- Allowed to modify:
  - `CONTEXT.md`（若需补充「商业软件平替映射 / 相似开源项目推荐」术语边界）
  - `docs/adr/0024-affinity-scoring-v2-and-shelf-sampling.md` 或新增 `docs/adr/0030-similar-apps-and-alternatives-search.md`
  - `.scratch/README.md`（更新 #37 进度状态）
  - `.scratch/feature-similar-and-alternatives/spec.md`（状态更新为 Implemented）
- Do not modify:
  - 无关功能模块代码

## Implementation Details

1. **文档与契约收敛**：
   - 检查新增命令 `get_similar_apps`、字段 `CatalogItem.alternatives` 与 `SearchResultsView` / `AppDetailModal` 的术语是否与 `CONTEXT.md` 一致；
   - 在 ADR 中记录「商业软件名仅作为开源平替检索词与标签，绝不入库为闭源条目」及「详情页相似推荐零网络复用 `CatalogIdf`」的设计决策。
2. **全量验证**：
   - 运行 Rust clippy 与全量单元测试；
   - 运行前端 `pnpm check`、Vitest 全量单测（含 `cmdAlignment`、`ipcArgsNaming`、`countDisplay`、`noDirectInvoke`、`views.i18n`）与 Demo 构建。

## Acceptance Criteria

- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
- [ ] `pnpm check`（含 TypeScript 编译、Vitest 测试与规则测试）全部通过。
- [ ] `pnpm build:demo`（若 `package.json` 存在）正常构建无报错。
