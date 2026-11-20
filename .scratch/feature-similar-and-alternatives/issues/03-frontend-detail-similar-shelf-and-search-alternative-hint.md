# Issue 03: 前端详情页「相似开源项目」推荐栏、平替标签与搜索命中提示

Status: resolved
Blocked by: 02

## Summary

在前端打通 `get_similar_apps` IPC 与 Demo Mock，在 `<AppDetailModal>` 底部新增 `<SimilarAppsSection>` 相似开源项目推荐区块、在详情弹窗 `<Header>` 透出商业软件平替标签，并在 `<SearchResultsView>` 展示搜索平替命中提示。

## Scope

- Allowed to modify:
  - `src/types/index.ts`（扩展 `AppSummary`/`AppDetail` 可选 `alternatives?: string[]`，新增 `SimilarAppItem`、`SimilarAppsResponse`、`RecommendationReason`）
  - `src/services/api.ts`（`CMD` 注册 `getSimilarApps: 'get_similar_apps'`）
  - `src/services/api/catalog.ts`（封装 `getSimilarApps`）
  - `src/demo/handlers/catalog.ts` & `src/demo/tauri-mock.ts`（补充 `get_similar_apps` Demo Mock 与 `alternatives` 平替检索支持）
  - `src/components/AppDetailModal/SimilarAppsSection.tsx`（新增）
  - `src/components/AppDetailModal/index.tsx`（挂载 `<SimilarAppsSection>`，支持弹窗内切换应用并重置滚动位置）
  - `src/components/AppDetailModal/Header.tsx`（展示单色 `target_alternatives` `.modal-tag`）
  - `src/views/SearchResultsView.tsx`（按需展示「可替代 X」平替命中徽标）
  - `src/styles/components-modal.css`（新增相似项目推荐栅格单色样式）
  - `src/locales/zh-CN.json` & `src/locales/en-US.json`（补充 `detail.similar.*`、`detail.alternatives_badge`、`search.alternative_to` 文案，严禁含 `({{count}})`）
- Do not modify:
  - `src-tauri/` 后端逻辑
  - `src/views/HomeView.tsx`（精选页货架保持由 `get_featured_page` 驱动）

## Implementation Details

1. **类型与 API 契约（`src/types/index.ts`, `src/services/api.ts`, `src/services/api/catalog.ts`）**：
   - `CMD.getSimilarApps = 'get_similar_apps'`。
   - `getSimilarApps` 仅传 camelCase 参数：`{ appId, name, owner, category, description, descriptionEn, limit }`。
   - 复用或对齐后端 `Reason` tagged enum 类型（`{ kind: 'owner', owner } | { kind: 'keywords', tokens } | { kind: 'category', category } | ...`）。
2. **`<SimilarAppsSection>` 组件（`src/components/AppDetailModal/SimilarAppsSection.tsx`）**：
   - 接收 `app: AppDetailViewModel`、`onSelectApp: (id: string) => void`；
   - 通过 `useEffect` + 请求世代号 `reqRef` 调用 `tauriApi.getSimilarApps`（在 `app.id` 稳定时执行；若 `app.isLoading` 为占位壳阶段且未携带分类/描述，在加载完成后补刷一次）；
   - 队列入队推荐卡片图标缓存（`queueAssembledRowIcons`）；
   - 当 `items.length === 0` 时返回 `null`（不渲染空板块）；
   - 有结果时渲染区块标题 + `<CountBadge value={items.length} />`，及 4 列（移动端/窄窗 2 列）单色卡片：
     - `<AppIconFrame size="sm">` + 应用名称 + Star 数 + 平台图标；
     - 下方展示单条可解释理由标签（`.status-tag`），优先 `keywords`（`包含关键词: xxx`）、`owner`（`同一作者`）、`category`（`同属「分类」`）；
     - 点击卡片执行 `onSelectApp(item.app.id)`，外层 `AppDetailModal` 触发 `onOpenDetail(id)` 并通过 `.modal-body` ref 将 `scrollTop = 0`。
3. **平替标签与搜索提示**：
   - `AppDetailModal/Header.tsx`：当 `alternatives`（来自 `app.alternatives` 或 `SimilarAppsResponse.target_alternatives`）非空时，在元信息行展示最多 2 项的 `.modal-tag`（例如 `可替代 TeamViewer · AnyDesk`），完整名单放 `title`。
   - `SearchResultsView.tsx`：当本地搜索结果卡片的 `app.alternatives` 中存在与 `searchQuery` 匹配的项（而 `app.name` 本身不包含该查询词）时，在卡片底部或标签区以 `.status-tag` 显示 `可替代 <matchedAlternative>`。

## Acceptance Criteria

- [ ] `<SimilarAppsSection>` 单测覆盖：加载后展示卡片与 `<CountBadge>`、空结果时不渲染区块、点击卡片触发 `onSelectApp` 并传递目标 `app.id`、卸载或快速切换 `app.id` 不发生过期响应覆盖。
- [ ] `AppDetailModal` 渲染测试验证平替 `.modal-tag` 在有数据时展示、无数据时隐藏。
- [ ] `pnpm test -- src/services/api/cmdAlignment.test.ts src/services/api/ipcArgsNaming.test.ts` 与 `countDisplay.test.ts`、`views.i18n.test.tsx` 全部通过。
