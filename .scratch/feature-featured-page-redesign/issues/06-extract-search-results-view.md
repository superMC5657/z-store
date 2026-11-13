# Issue 06: 搜索结果拆为 `SearchResultsView`（纯重构）

Status: resolved
Blocked by: none

## 背景

`HomeView.tsx`（约 740 行）同时承载精选与本地/在线两段搜索结果。新精选页要整体替换非搜索部分，先把搜索拆走，降低替换风险（ADR-0023 §2.7）。

## 目标

1. 新建 `src/views/SearchResultsView.tsx`，搬入搜索态的本地段、在线段、在线续拉（`useOnlinePullToLoadMore`）、移入收录、黄标叠加与图标补拉逻辑；共用的标注逻辑（`withLocalAndStars`、空图标按需拉取、组装落盘补齐）抽成 `src/views/shared/useAnnotatedRows.ts` 之类的 hook，供后续 `FeaturedView` 复用。
2. `App.tsx`：`currentView === 'home'` 时，有搜索词渲染 `SearchResultsView`，否则渲染 `HomeView`；两段都空的整页空态保持在 App 侧不变。
3. `HomeView` 删除所有搜索相关 props 与分支。
4. 行为零变化：DOM 结构、`data-testid`、文案键不变。

## 范围（互斥）

- 允许修改：`src/views/HomeView.tsx`、`src/views/SearchResultsView.tsx`（新建）、`src/views/shared/*`（新建）、`src/App.tsx`（仅 home 分支）、相关测试（搜索类用例迁到 `SearchResultsView.*.test.tsx`）。
- 禁止触碰：`src-tauri/*`、`src/views/HomeView/useHomeFeed.ts`（issue 05 在改）。

## 验收标准

- [ ] `HomeView.online-more.test.tsx`、`HomeView.search-icon.test.tsx`、`HomeView.localBadgeTiming.test.tsx` 迁移后断言不变并通过。
- [ ] `noDirectInvoke.test.ts`、`views.i18n.test.tsx` 通过。
- [ ] `pnpm test` 全绿。
