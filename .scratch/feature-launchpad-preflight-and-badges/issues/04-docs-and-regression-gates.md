# Issue 04: 文档同步、ADR 补充与全量回归门禁

Status: resolved
Blocked by: 02, 03

## Summary

完成特性 #39 的领域文档与 ADR 同步，并执行全量 Rust 与前端测试、类型检查及规范门禁验证。

## Scope

- Allowed to modify:
  - `docs/adr/0029-launchpad-social-discovery-and-isolated-manifest.md`（补充应用内投稿预检与徽章分享器边界说明）
  - `README.md` / `README.zh-CN.md`（补充应用内预检投稿与 README 徽章功能介绍）
  - `.scratch/README.md`（更新 #39 进度状态）
  - `.scratch/feature-launchpad-preflight-and-badges/spec.md`（状态更新为 Implemented）
- Do not modify:
  - 无关功能模块代码

## Implementation Details

1. 更新 `ADR-0029` 与 `README`，明确客户端预检向导只读检查 + 浏览器预填 Issue Form 的零额外 OAuth 权限边界。
2. 全量运行 Rust 与前端静态/单元测试与 Demo 构建，确保所有门禁通过。

## Acceptance Criteria

- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
- [x] `pnpm check`（含 TypeScript、Vitest 全量测试、`cmdAlignment`、`ipcArgsNaming`、`countDisplay`、`noDirectInvoke`、`modalLayers`）通过。
- [x] `pnpm build:demo` 构建无误。
