# 03: 待收录 3 Tab + 本地收录内部分段

**What to build:** 待收录页从四个互斥 Tab 收成三个：草稿 / 本地收录 / 已归档；Issue 进度降为「本地收录」内部的分段：全部 · 待提交 · 已提交。计数按 Tab 分区，不重计；归档行只作记录展示。

**Status:** resolved

- [x] `PendingGroupId` 改为 `draft | library | archived`；`entryGroup`：archived 优先 → draft → library（collected 系 + submitted）
- [x] 「本地收录」分段状态（默认「全部」）：全部 = collected 系 + submitted；待提交 = collected 系；已提交 = submitted
- [x] Tab 计数 = 分区行数（`draft + library + archived` 恒等于全部条目数（含已归档）；侧栏 `pendingCount` 仍为未归档数）
- [x] 批量栏：仅「本地收录」且分段 ≠ 已提交时出现；可选行仍只限 collected 系（submitted 不可勾选）
- [x] 切 Tab / 分段重置选中、表单、报错，沿用现有行为；空态按分段给文案
- [x] 富卡：submitted 复用现有只读富卡（Issue 链接、已提交徽标）；archived 保持只读 + 黄标记录态
- [x] 中英文案：`pending.groups.library`、`pending.segments.*`；新增文案不散落硬编码
- [x] 测试：分组/计数总和/分段过滤/批量门禁/submitted 富卡/archived 不回退
- [x] `tsc --noEmit` + `PendingView*.test` 全绿

**Blocked by:** 02（库内谓词）

## Comments
- 2026-10-20：已实施。3 Tab（草稿/本地收录/已归档）+ 内部分段（全部/待提交/已提交）；计数分区为全部条目（含已归档），侧栏角标仍为未归档数；批量栏只在本地收录 · 非已提交段出现，submitted 永不可勾选并随父级刷新剔除；空态/中英文案齐备。验证：PendingView 50 项 + pr 34 项 + IPC 命名/无直调，共 113 项通过。
