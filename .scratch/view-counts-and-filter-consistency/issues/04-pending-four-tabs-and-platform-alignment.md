# Issue 04: 待收录子页展平为四个顶层 Tab、智能默认落点与全局设备平台筛选对齐

Status: resolved
Blocked by: 02

## Summary

按已确认的产品结构，重构 **待收录页（`PendingView`）** 的分组模型与平台筛选联动，彻底消除顶层角标、二级分段、侧栏导航角标与左栏实际条目列表之间的多处错位：

1. **展平为四个顶层互斥 Tab（移除「本地收录」二级分段）**：
   - 将原有的 3 顶层 Tab（`草稿 / 本地收录 / 已归档`）+ `本地收录` 内置 2 分段（`待提交 / 已提交`）展平为 **4 个平级顶层 Tab**：
     - `draft`（草稿）
     - `to_submit`（待提交：`!archived && isCollectedStatus(status)`）
     - `submitted`（已提交：`!archived && status === 'submitted'`）
     - `archived`（已归档：`archived === true`）
   - 移除 `.pending-segment-row` 与 `PendingSegmentId`；每个顶层 Tab 的 `<CountLabel>` 数字严格等于切入该 Tab 后左栏渲染的条目数。
2. **接入全局设备平台筛选（`selectedPlatforms`）与侧栏平台计数上报**：
   - `PendingView` 接收可选 `selectedPlatforms`、`onResetPlatformFilter` 与 `onDisplayPlatformCounts`（未传入 `selectedPlatforms` 时默认全选 `PLATFORM_IDS`，保持独立单测与受控/非受控模式兼容）；
   - 按 `matchPlatformSet({ platforms: entry.item.platforms }, selectedPlatforms)` 过滤条目（空 `platforms` 归入虚拟 `'other'` 桶），4 个顶层 Tab 的角标同步展示平台过滤后的计数；前 3 个未归档 Tab（`草稿 + 待提交 + 已提交`）的计数之和与侧栏「待收录」角标 `pendingCount` 完全相等；
   - 向侧栏上报待收录条目的平台分布（在 `archived` Tab 时统计已归档条目分布，在其余未归档 Tab 时统计未归档条目分布，使侧栏各平台芯片数字与当前可见的未归档/归档作用域一致）；
   - 当某 Tab 在未过滤前有条目、但因 `selectedPlatforms` 过滤后为空时，展示平台筛选专属空状态与「显示全部平台」重置动作（新建草稿 `isCreating` 或正在编辑中的表单保持不丢失）。
3. **首次进入智能默认 Tab 落点**：
   - 挂载（或首次收到后端非空 `entries`）且用户尚未手动切过 Tab、未处于新建态时，按 `draft → to_submit → submitted → archived` 顺序自动落在第一个过滤后计数 `> 0` 的 Tab（若因平台过滤全为 0，则落在第一个原始非空 Tab 以展示重置引导），确保从非零侧栏角标进入页面第一眼必看到对应列表。

## Scope

- Allowed to modify:
  - `src/views/PendingView.tsx`
  - `src/views/pending/draftModel.ts`
  - `src/views/pending/PendingListColumn.tsx`
  - `src/styles/components-pending.css`（清理不再使用的 `.pending-segment*` 死样式或复用空态布局）
  - `src/App.tsx`（向 `PendingView` 传入 `selectedPlatforms`、`onResetPlatformFilter`、`onDisplayPlatformCounts`）
  - `src/locales/zh-CN.json`
  - `src/locales/en-US.json`
  - `src/views/PendingView.test.tsx`
  - `src/views/PendingView.pr.test.tsx`
  - `src/styles/buttons.parity.test.tsx`（仅当其引用了旧 `pending-segment` 选择器时同步适配 4-Tab 选择器）
- Do not modify:
  - `src-tauri/*`
  - `src/views/LatestView.tsx`, `src/views/CategoriesView.tsx`, `src/views/InstalledView.tsx`, `src/views/FavoritesView.tsx`

## Implementation Details

### 1. `src/views/pending/draftModel.ts` 四态分组归一

- 更新类型与分组纯函数：
  ```ts
  export type PendingGroupId = 'draft' | 'to_submit' | 'submitted' | 'archived';

  export function entryGroup(e: CustomDraftEntry): PendingGroupId {
    if (e.archived) return 'archived';
    if (e.status === 'submitted') return 'submitted';
    if (isPendingCollectedStatus(e.status)) return 'to_submit';
    return 'draft';
  }
  ```
- 移除已废弃的 `PendingSegmentId` 与 `entrySegment`。

### 2. `src/views/PendingView.tsx` 顶层四 Tab、操作流跳转与平台过滤

- 顶层 `GROUP_META` 定义 4 项（选用语义清晰的 `lucide-react` 13px/1.5 线性图标，如 `FilePlus2` / `PackageCheck` / `Send` / `Archive`），文案读取：
  - `draft`: `pending.groups.draft`（「草稿 / Drafts」）
  - `to_submit`: `pending.groups.to_submit`（「待提交 / Ready to Submit」）
  - `submitted`: `pending.groups.submitted`（「已提交 / Submitted」）
  - `archived`: `pending.groups.archived`（「已归档 / Archived」）
- 状态流转自动切 Tab 对齐新 ID：
  - `handleCollectLocal` 成功 → `setActiveGroup('to_submit')`；
  - `handleMarkSubmitted` 成功 → `setActiveGroup('submitted')`；
  - `handleRevertToDraft` 成功 → 停留在 `'to_submit'` 并选中剩余同组下一条（无剩余回空态）；
  - `handleWithdrawSubmitted` 成功 → 停留在 `'submitted'` 并清空选中（或落至 `'to_submit'`？保持现有撤回后清空选中语义，条目进入 `'to_submit'` 组）；
  - `handleStartCreate` / `handleDuplicateDraft` / `handleSave` → `setActiveGroup('draft')`。
- 平台过滤与计数：
  - 维护 `rawCounts`（未按平台过滤的 4 组计数）与 `counts`（按 `selectedPlatforms` 过滤后的 4 组计数）；
  - `visibleEntries = entries.filter((e) => entryGroup(e) === activeGroup && matchesPlatform(e))`；
  - 右侧富卡判定保持 `const isRichCollectedView = !isCreating && editingEntry !== null && entryGroup(editingEntry) !== 'draft';`（`to_submit`、`submitted`、`archived` 均展示 `PendingRichCard`，仅 `draft` 展示表单）；
  - 智能初始落点：用 `userPickedGroupRef = useRef(false)` 与 `didAutoSelectGroupRef = useRef(false)`，当 `entries.length > 0` 首次到达且用户未手动选过 Tab、非 `isCreating` 时，若当前 `counts[activeGroup] === 0`，自动切换到 `['draft', 'to_submit', 'submitted', 'archived']` 中首个 `counts[g] > 0`（若全为 0 则首个 `rawCounts[g] > 0`）的分组。
- `PendingListColumn.tsx`：
  - 移除 `activeSegment` prop，按 4 个 `activeGroup` 渲染精准空态文案；若 `entries.length === 0 && rawGroupCount > 0`（当前分组有条目但被侧栏平台筛选隐藏），显示平台筛选为空提示与「显示全部平台」按钮（调用 `onResetPlatformFilter`）。

## Acceptance Criteria

- [x] `PendingView.test.tsx` 与 `PendingView.pr.test.tsx` 更新并通过，验证：
  - 顶层渲染 4 个 Tab（`草稿 / 待提交 / 已提交 / 已归档`），无二级分段行；每个 Tab 的角标严格等于点击后 `.pending-list` 内渲染的条目数；
  - 当 `entries` 仅有 `2` 条 `collected` 与 `1` 条 `submitted`（`draft = 0`）时，挂载进入 `PendingView` 自动落在 `待提交 2` Tab 并展示这 2 条，不再停在空的 `草稿 0`；
  - 当传入 `selectedPlatforms={new Set(['macos'])}` 时，4 个 Tab 角标与左栏列表仅统计/展示含 `macos` 平台的条目，被筛空的非空分组展示平台重置按钮并可触发 `onResetPlatformFilter`；
  - `onDisplayPlatformCounts` 准确上报待收录条目的平台分布。
- [x] `countDisplay.test.ts`（无括号计数、无私有计数类名）、`i18n.test.ts`（中英文键对称）与 `npx tsc --noEmit` 全部通过。
