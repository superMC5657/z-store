# Issue 06: 领域文档同步（`CONTEXT.md` / `ADR-0013`）与全量验收

Status: resolved
Blocked by: 04, 05

## 背景

在完成本地用户画像、Catalog 动态推荐与设置页隐私数据看板后，需按仓库 `docs/agents/domain.md` 规范将新增领域概念与排序契约同步至 `CONTEXT.md` 与 `docs/adr/0013-feed-contract.md`，并执行全量门禁回归。

## 目标

1. **`CONTEXT.md` 同步**：
   - 在「一、统一领域词汇表」新增 **本地亲和度画像 (`User Affinity Profile`)**、**仓库特征信号 (`Repo Affinity Signal`)** 与 **本地隐私数据看板 (`Affinity Privacy Audit Panel`)** 标准术语定义；
   - 在「二、架构核心边界与原则」D2 / D9 条款中补充 `user_repo_signals` 表说明及发现页基于本地画像 + `stars`/`forks` 双因子动态混排的说明。
2. **`docs/adr/0013-feed-contract.md` 同步**：
   - 补充说明 `balanced` 策略在启用 `enable_local_affinity` 且存在本地 GitHub Star/Fork 或应用内 Star/Watch 画像信号时自动升级为个性化亲和度重排（无信号或关闭开关时退化为星数+Fork 对数基线），保持首页无策略切换工具条的极简契约不变。
3. **全量门禁执行**：
   - `cargo test --manifest-path src-tauri/Cargo.toml`
   - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
   - `npx tsc --noEmit`
   - `npx vitest run`

## 范围

- 允许修改：`CONTEXT.md`、`docs/adr/0013-feed-contract.md`、`.scratch/feature-local-affinity-recommendation/plan.md`。

## 验收标准

- [x] 文档描述当前行为而非变更历史，术语与代码结构体命名严格一致。
- [x] 前后端全量测试、类型检查与 Clippy 零警告通过。
