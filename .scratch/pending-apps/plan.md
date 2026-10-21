# 本地库状态模型重构 · 开发计划

Status: Draft（待 D1–D5 拍板）
Baseline: `077e82b`（草稿不叠黄标已修）+ 当前 HEAD
Scope: 待收录四状态收口、提交后仍在本地库、归档由远端接手

## 1. 结论

四个状态不是一条互斥流水线，而是两个正交维度：

| 维度 | 取值 |
| --- | --- |
| 库内归属 | 草稿（不在库）→ 已收录/已提交（在库）→ 已归档（退出库，权威交给远端） |
| 上游进度 | 无 → 已提交 Issue（`submitted`，待收录）→ 已收录（`archived`） |

因此：

- `submitted` = 库内成员 + 上游“已提交”，**不是** 离开本地库的第四种桶。
- `archived` = 同一 canonical id 的权威源由 `local` 切换为 `remote`，本地行只留档。
- UI 收成 3 Tab（草稿 / 本地收录 / 已归档），Issue 进度作为「本地收录」内部的分段。

## 2. 产品不变量（验收口径）

- **I1 库内成员**：`!archived && status ∈ {collected, local_collected, submitted}`。
- **I2 黄标**：库内成员且 `is_verified !== true`；蓝标恒优先。
- **I3 可提交 Issue / 可退回**：仅 `collected` 系且未归档；`submitted` 两条都拒绝。
- **I4 归档切换**：同 id 远端优先、只出现一张卡、黄标转蓝标、不闪空、本地行不参与合并/计数/搜索。
- **I5 首刷未知 ≠ 空**：`customApps === null` 时不得误标、误清；就绪后重标。

## 3. 分期与任务

### P1 · 同步后刷新（独立，可先发）

现状：`SettingsView.tsx:104` 同步成功只派发 `zstore:catalog-synced`，App 的 `customApps` 只监听 `zstore:custom-apps-changed`（`App.tsx:117`）。转正后待收录页仍把行留在「本地收录」，直到重启。

- 同步成功后同时派发 `custom-apps-changed`（或在 `catalog-synced` 监听里重载 customApps）；选择唯一收口，避免两处各发一次。
- 若存在启动自动同步路径，把派发放到同步成功 seam，而非只放 SettingsView。
- 测试：同步成功后两条事件均派发 / App 重载后归档行离开「本地收录」、计数更正。
- 退出标准：手动同步触发转正后，无需重启即移到「已归档」，首页保持单卡蓝标。

### P2 · L1 数据口径（提交后仍在库）

后端（`src-tauri/src/db/custom_apps.rs`、`commands/catalog_custom.rs`）：

- 新增 `is_local_library_status(status) = is_collected_status(status) || status == "submitted"`。
- `list_local_library_apps` / `list_local_library_items`（`:455` 起，含 `submitted`；旧名 `list_collected_*` 已合并），同步 `catalog_service.rs:94` 与测试。
- `get_collected_custom_item`（`:473`，详情/安装回退）改库内谓词。
- `collected_overlay_items`（`catalog_custom.rs:361`）改库内谓词；`get_merged_catalog_view` 注释同步。
- **门禁不动**：`mark_submitted`、`mark_collected`、`revert_collected_to_draft`、`ensure_collected_for_pr` 继续拒绝/限定 `submitted`。
- `backfill_cataloged_flags` 经 `list_*` 自动覆盖 submitted：已提交应用的收藏/关注 `is_cataloged` 保持 true（预期）。
- `resolve_catalog_stamp` 继续对本地命中盖 `source=local`（`status` 归一到 collected 仅作徽标用）；「已提交」区分只存在于待收录列表。

前端：

- `app/selectors.ts` 新增 `isLocalLibraryStatus`；`App.tsx` 的 `collectedSummaries` 改用（建议变量改名 `localLibrarySummaries`，prop 仍叫 `localApps`）。
- `VerifiedBadge.resolveVerifiedBadgeVariant` 的 status 兜底改用库内谓词（旧载荷无 source 时 submitted 也显黄）。
- 黄标/可搜可装/平台计数/收藏 join 都经 `collectedSummaries` 派生，一处改完全链路生效。
- 测试：submitted 进入合并目录 + 首页/趋势黄标 + 可装；Issue/退回门禁仍拒；`local_collected` 行为不回退。

退出标准：提交 Issue 后应用仍出现在首页/分类/搜索/趋势，可装，黄标在；待收录「本地收录」计数含它。

### P3 · L2 UI 分桶（3 Tab + 内部分段）

`PendingView.tsx`：

- `PendingGroupId`：`draft | library | archived`；`entryGroup`：`archived` 优先，其次 `draft`，其余进 `library`。
- 「本地收录」内部分段：`全部 / 待提交 / 已提交`（默认全部）；切 Tab 重置选中/表单/报错，沿用现有逻辑。
- 计数按 Tab 分区不重计（`library` = collected 系 + submitted）；侧栏角标仍为未归档总数。
- 批量栏：仅 `library` 且分段 ≠ 已提交时出现；可选行仍只限 collected 系。
- 富卡：submitted 复用现有只读富卡 + Issue 链接；动作按 D1 决策。
- 空态/文案：新增分段空态；中英文案（`pending.groups.library`、`pending.segments.*`）。
- 测试：分组/计数分区总和（全部条目，含已归档）、分段过滤、批量门禁、submitted 富卡动作、archived 不回退。

退出标准：3 Tab 可用；「本地收录 2」包含 1 条待提交 + 1 条已提交；批量只在待提交段出现。

### P4 · 标记为未提交（依赖 D1，默认做）

- 后端新命令 `withdraw_submitted`：`submitted → collected`，`pr_url=NULL`，已归档拒绝；提示“Issue 需自行关闭”。
- API 封装 + PendingView 动作 + 二次确认 + 文案。
- 测试：撤回后可重新提交；撤回不清 payload；归档行拒绝。
- 若 D1 选择“只读直到转正”，本阶段删除。

### P5 · 文档与全量验收

- ADR-0017：两轴模型、库内谓词、归档=权威切换、撤下语义、已知边界（catalog 下架不回补）。
- `CONTEXT.md`：新增「本地库 / 库内成员 / 已提交」，明确 `isCollectedStatus`（可提交 Issue）与 `isLocalLibraryStatus`（在库）两个谓词的区别。
- `.scratch/pending-apps/SPEC.md` §3/§4：状态机、黄标覆盖面、归档展示。
- 门禁：`npx tsc --noEmit`、`npx vitest run`、`cargo test`（或分两次 `cargo test custom_apps` / `cargo test catalog_custom`）；手动清单见 §6。

## 4. 待拍板

| ID | 议题 | 推荐 | 影响 |
| --- | --- | --- | --- |
| D1 | 已提交行可否「标记为未提交」 | 可（清 `pr_url` 回 collected，Issue 自行关闭） | 决定 P4 是否存在 |
| D2 | 已提交行可否「退回草稿」 | 否（Issue 还在外面，避免库内/上游错位） | 门禁文案 |
| D3 | 待收录「已归档」页是否保留黄标 | 保留记录态，叠加「已转正归档」 | 无需改码 |
| D4 | 远端未验证行归档后无任何标 | 接受，不造第三徽标 | 文档声明 |
| D5 | catalog 后来下架导致已归档应用消失 | 接受，ADR 记已知边界；不做回补 | 文档声明 |

D1/D2 阻塞 P3；D3–D5 只影响文档。

## 5. 风险

- **R1 双谓词误用（最高）**：`isCollectedStatus` 与 `isLocalLibraryStatus` 混用会把提交行重新当“非库内”或把草稿放进门禁。用 CONTEXT 词汇表 + 测试命名锁定；门禁测试单独保留。
- **R2 计数重计/漏计**：Tab 分区断言总和 = 未归档数。
- **R3 批量误选**：submitted 永远不可勾选；批次门禁测试。
- **R4 回退口遗漏**：`get_collected_custom_item` 必须改，否则 submitted 详情/安装回退取不到本地行。
- **R5 收藏/关注标记语义变化**：submitted 仍算已收录（预期），补回填测试。
- **R6 归档不可逆**：文档明确，不做隐式恢复。

## 6. 验收清单

- Given 已收录，When 提交 Issue，Then 首页/搜索/趋势仍见、可装、黄标在；「本地收录」计数含它；批量不再选它。
- Given 已提交，When 打开待收录，Then 位于「本地收录 · 已提交」，Issue 链接可见，无表单。
- Given 转正同步，When 同步完成，Then 立即移到「已归档」（无需重启）；首页单卡由黄转蓝。
- Given 已收录，When 退回草稿，Then 各处立即去黄（已实现，保持）。
- Given 已提交，When 点退回草稿，Then 拒绝；若 D1 采纳，可「标记为未提交」回到待提交。
- Given 首刷 `customApps=null`，Then 不误标/误清，就绪后重标。

## 7. 不做

- 取消 `status=submitted` 改用 `pr_url` 派生（等 GitHub Issue 状态回收一起做）。
- 第三个来源徽标；归档回补。
- 技术债（lookup 三处复制收敛、`useAppSelectors` 形参 `customApps` 改名）另记，不混入本计划。

## 8. Issue 拆分建议

- `issues/01-sync-refresh-archived.md`（P1）
- `issues/02-local-library-semantics.md`（P2）
- `issues/03-pending-three-tabs.md`（P3）
- `issues/04-withdraw-submitted.md`（P4，D1 采纳后）
- `issues/05-docs-acceptance.md`（P5）

估算：P1 0.5d · P2 1–1.5d · P3 1.5–2d · P4 0.5–1d · P5 0.5d，合计约 4–5 个开发日（不含评审）。

## 9. 进度（2026-10-20）

- [x] 01 同步后刷新（`SettingsView` 双事件 + 用例）
- [x] 02 本地库口径（Rust 谓词/列表/overlay/详情回退 + FE 合并/徽标）
- [x] 03 3 Tab + 内部分段（计数分区、批量门禁、中英文案）
- [x] 04 标记为未提交（后端命令 + API + 已提交富卡动作）
- [x] 05 文档（ADR-0017 §2.7、CONTEXT 词汇表、SPEC §3/§4）
- [ ] 手动验收：提交后仍在库 / 转正黄转蓝单卡 / 撤下回待提交 / 归档只读
- 门禁：`tsc --noEmit` 干净 · vitest 723 · cargo 325
