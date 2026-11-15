# Issue 06: 数量显示与领域规范文档同步及全量回归门禁验收

Status: resolved
Blocked by: 03, 04, 05

## Summary

在 Issue 01–05 全部合入后，同步更新仓库数量显示规范与领域契约文档，补齐跨视图端到端集成回归测试，并执行全量 Rust + TypeScript + Demo 构建门禁验收。

## Scope

- Allowed to modify:
  - `docs/count-display.md`
  - `CONTEXT.md`
  - `src/App.platformFilter.test.tsx`
  - `src/App.searchPlatformCounts.test.tsx`
  - `.scratch/view-counts-and-filter-consistency/spec.md`（完成后将顶部状态更新为 `Implemented`）
- Do not modify:
  - 业务逻辑实现文件（除非回归门禁暴露出遗漏的边界缺陷）

## Implementation Details

### 1. 文档与领域词汇同步（描述当前行为，不记变更历史，遵循 `AGENTS.md`）

- **`docs/count-display.md`**：
  - 明确「数量与可见内容同源」原则：所有筛选 Tab、子页标题 `<CountBadge>` 及底部叙述计数必须反映当前激活的全局设备平台筛选与页内筛选作用域下的真实可展示数量（分页列表标题取当前筛选条件下的总匹配数，绝不取未加载完的单页切片长度或未按平台过滤的全库数）；
  - 更新「待收录」说明：顶层四个平级 Tab（`草稿 / 待提交 / 已提交 / 已归档`）各自携带 `<CountLabel>`，侧栏「待收录」角标为未归档三项之和（`hideZero`）；
  - 更新「我的应用」与「收藏 / 关注」说明：页内搜索框与全局平台筛选实时联动页内 Tab 角标，侧栏平台芯片计数随当前视图/子签展示对应数据集的平台分布。
- **`CONTEXT.md`**：
  - 核对并同步「双维目录筛选 / 设备平台过滤」、「待收录草稿 / 本地库」、「最新入库」、「我的应用」条目描述，使其准确描述当前全站平台过滤、四态 Tab 与视图级平台分布计数的现行契约。

### 2. App 级跨视图集成回归测试（`src/App.platformFilter.test.tsx`）

- 新增端到端视图切换回归用例，覆盖以下核心场景：
  1. **顶栏搜索后切页不丢卡**：在首页顶栏搜索某关键词后，依次切换至「最新入库」「分类浏览」「收藏（含收藏签与关注签）」「我的应用」，断言各页面计数角标与卡片列表完整展示全量平台匹配数据，不受顶栏残留搜索词裁剪；
  2. **侧栏平台筛选全站一致性**：在侧栏仅勾选单一平台（如 `Windows` 或 `Android`）或清空平台（`0/6`）时，断言「最新入库」「分类子页」「待收录」「我的应用」「收藏 / 关注」的页内角标与实际卡片数严格相等，且 `0/6` 时全部展示 `FilterEmptyState` 重置入口。

### 3. 全量门禁执行清单

依次运行并确认零警告、零错误：
1. `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
2. `cargo test --manifest-path src-tauri/Cargo.toml`
3. `npx tsc --noEmit`
4. `npx vitest run`（特别确认 `countDisplay.test.ts`、`ipcArgsNaming.test.ts`、`noDirectInvoke.test.ts`、`i18n.test.ts` 通过）
5. `npx vite build --config vite.demo.config.ts`

## Acceptance Criteria

- [ ] `docs/count-display.md` 与 `CONTEXT.md` 准确反映现行实现，无历史演进措辞，不引入任何违反 `countDisplay.test.ts` 的示例。
- [ ] 新增的 App 级跨视图数量一致性回归测试通过。
- [ ] 上述 5 项全量构建与测试门禁 100% 绿灯通过。
