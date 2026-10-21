# Issue 05: PendingView 保存类回调无 catch，按钮永久卡提交态

Status: resolved
Priority: P1（前端正确性）
来源: 2026-10-21 全项目审查 · 前端核心分片

## 描述

`src/views/PendingView.tsx:882`（同类 :930 等共 4 处：onMarkSubmitted / onCollectLocal /
onWithdrawSubmitted）→ `src/App.tsx:159-179` 两侧均无 catch。后端 reject 时：

- 无失败 toast，用户不知道操作失败；
- `setIsCreating(false)` 不执行，保存按钮永久卡在提交态，只能刷新。

## 修复方向

- 四个回调统一包 try/catch + finally：catch 里 toast 报错并回滚乐观态，finally 里
  `setIsCreating(false)`。
- 可抽一个 `withSaving(setter, fn)` helper 收口，避免四处重复（与 25 号工单拆分联动）。

## Comments

- 2026-10-21: 审查时点与现状有偏差——collect/withdraw/revert 三处在 1ac41eb 已带 try/catch/finally，实际缺口为 `handleSave`/`handleDelete`/`handleMarkSubmitted` 三处 await 无 catch。本次只补这三处（行内 try/catch，不抽 helper，保持 25 号工单拆分前的回调结构最小改动）。
- `handleSave`：catch 里 toast `pending.save_failed` 并 return，**刻意偏离工单"finally 里 setIsCreating(false)"的写法**——保存失败即关表单会丢用户全部输入；停留编辑态即失败回滚（成功路径的出表单/选中/切组一概不执行），保存按钮可再次点击重试，不存在卡死。
- `handleDelete`：catch 里 toast `pending.delete_failed` 并解除二次确认态，成功路径的清选中不执行。
- `handleMarkSubmitted`：catch 里 toast `pending.mark_submitted_failed` 并 return（不切已提交分段），成功路径的切组/提示不执行。
- App.tsx:159-179 侧的五个 handler 保持透传抛错契约不变：PendingView 侧 catch 已覆盖全部调用入口（collect/withdraw/revert 原有 catch + 本次三处），不再叠加 App 级 toast 避免双报。
- 新增 i18n key：`pending.save_failed`、`pending.delete_failed`、`pending.mark_submitted_failed`（zh-CN/en-US）。
- `PendingView.test.tsx` 新增"保存类回调失败路径"3 例：reject → 对应错误 toast + 无成功提示 + 停留可重试态；红测验证旧代码 3 例均以 unhandled rejection 失败。
