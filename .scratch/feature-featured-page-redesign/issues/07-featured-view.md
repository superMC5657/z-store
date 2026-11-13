# Issue 07: `FeaturedView` 渲染货架页（取代 `HomeView` 非搜索部分）

Status: resolved
Blocked by: 04, 05, 06

## 背景

按 spec §2、§3 实现新精选页的只读部分（反馈与兴趣选择卡在 issue 08）。

## 目标

1. API 层：`src/services/api/catalog.ts` 新增 `getFeaturedPage({ daySeed, platforms })`，命令表登记 `get_featured_page`；`src/types` 新增 `FeaturedPage` / `FeaturedPick` / `FeaturedShelf` / `Reason`。
2. `src/views/FeaturedView.tsx` + `src/views/FeaturedView/useFeaturedPage.ts`：
   - 进入视图、平台选择变化、画像更新事件（`subscribeAffinityUpdated`）到达时拉取；同一会话内不因其它重渲染重拉。
   - 平台选择为 `[]` 时不发请求，渲染现有 `FilterEmptyState`。
   - 区块：画像状态栏、hero、`because_you` / `category_pick` / `explore` / `fresh` 货架、主流（复用 `useHomeFeed`，滤掉上方已出现的 id）、「继续查看」细条。
   - 理由渲染为卡片底部一行次要文字，文案键 `featured.reason.*`，按 `kind` 与 `relation` 取模板；分类名经 `getCategoryLabel`。
   - 卡片沿用 `AppCard`（新增可选 `reasonText` 插槽），黄标 / 蓝标 / 星数修补复用 issue 06 抽出的 hook。
3. `App.tsx` 中非搜索态渲染 `FeaturedView`；删除 `HomeView.tsx` 及 `resolveHero`、`home.rustdesk_*`、`home.classic_featured` 等不再使用的文案与样式。
4. 演示站 mock：`get_featured_page` 返回 `rich` 形态（用 `catalog.json` 头部条目拼），可经 URL 参数切 `cold`；参数只认 camelCase。
5. 视觉遵循 D4 Linear 去彩单色；数字附于标签时用 `<CountBadge>`。

## 范围（互斥）

- 允许修改：`src/views/FeaturedView*`（新建）、`src/views/HomeView*`（删除 / 迁移）、`src/App.tsx`、`src/services/api*`、`src/types*`、`src/components/AppCard*`（仅新增插槽）、`src/demo/tauri-mock.ts`、`src/locales/*.json`、`src/styles/*`。
- 禁止触碰：`src-tauri/*`。

## 验收标准

- [ ] 单测：四种 `profile_state` 各渲染对应区块组合（mock API）。
- [ ] 单测：主流不重复显示 hero / 货架中的 id。
- [ ] 单测：理由文案中英文键齐全（`views.i18n.test.tsx`）。
- [ ] `ipcArgsNaming.test.ts`、`noDirectInvoke.test.ts`、`countDisplay.test.ts` 通过。
- [ ] 演示站构建后精选页可渲染 `rich` 与 `cold`，附截图。
