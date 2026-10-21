# 04: 标记为未提交（submitted → collected）

**What to build:** 已提交行提供「标记为未提交」：清 `pr_url`、回到待提交，可重新提交；Issue 需用户在 GitHub 自行关闭（文案提示）。已归档行拒绝；submitted 仍不允许「退回草稿」（避免库内/上游错位）。

**Status:** resolved

## 契约

- Rust 新命令 `withdraw_submitted(id)`：仅 `status=submitted && !archived` 放行；置 `status='collected'`、`pr_url=NULL`，payload 不变；错误分层与现有命令一致；注册到 `lib.rs` 命令表。
- TS：`CMD.withdrawSubmitted = 'withdraw_submitted'`，`catalog.ts` 封装 `withdrawSubmitted(id): Promise<CustomAppEntry>`，经 `services/api` 导出；`ipcArgsNaming.test` 覆盖。
- PendingView：已提交富卡新增动作 + 二次确认 + 成功/失败 toast；成功后行回到「待提交」，批量重新可选。
- D2：submitted 不提供「退回草稿」，后端拒绝保持。

## 验收

- [x] 撤下成功：`status=collected`、`pr_url=null`、payload 不变；可再次 mark submitted。
- [x] 撤下后立刻回到待提交分段，黄标/可装状态不变。
- [x] 归档行、非 submitted 行拒绝并给出明确文案。
- [x] 测试：Rust roundtrip/门禁 + FE IPC 命名 + PendingView 动作流。

**Blocked by:** 02, 03

## Comments
- 2026-10-20：已实施。后端 `withdraw_submitted`（DB + 命令 + overlay 同步）；前端 `tauriApi.withdrawSubmitted` + 已提交富卡二次确认动作（未接线回调时不渲染）。Issue 关闭在 GitHub 侧由用户完成（文案提示）。验证：Rust 325 通过；FE 全量 723 通过。
