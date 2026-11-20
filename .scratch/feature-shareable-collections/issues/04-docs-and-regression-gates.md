# Issue 04: 文档同步、ADR 补充与全量回归门禁

Status: resolved
Blocked by: 03

## Summary

完成特性 #38 的领域词汇与深链协议文档更新，并运行全量前后端检查与测试门禁。

## Scope

- Allowed to modify:
  - `CONTEXT.md`（更新「协议深层链接」描述，涵盖 `zstore://collection` 合集深链）
  - `README.md` / `README.zh-CN.md`（深链 `<details>` 示例清单补充 `zstore://collection` 用法）
  - `.scratch/README.md`（更新 #38 进度状态）
  - `.scratch/feature-shareable-collections/spec.md`（状态更新为 Implemented）
- Do not modify:
  - 无关功能模块代码

## Implementation Details

1. 检查并同步 `CONTEXT.md` 中的 `Deep Linking` 词条及 `README.md` / `README.zh-CN.md` 协议示例。
2. 确认所有深链测试（含模糊/恶意编码输入、NUL 注入、超长截断、Demo 模式点击流）及 UI 门禁全部通过。

## Acceptance Criteria

- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
- [x] `pnpm check`（含 TypeScript、Vitest 全量测试、`cmdAlignment`、`ipcArgsNaming`、`countDisplay`、`noDirectInvoke`）通过。
- [x] `pnpm build:demo` 构建无误。
