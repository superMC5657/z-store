# Issue 04: 开源广场双区视图（Spotlight + 新品流）、一键 Star、作者画像联动与筛选计数对齐

Status: done
Blocked by: 03

## Summary

实现客户端「开源广场（`LaunchpadView`）」完整界面与交互闭环：

1. **页面结构与商业化展示**：
   - 右上角常驻「提交我的开源作品」下拉菜单（GitHub Issue 预填表单 / 官网投稿指南）与手动刷新按钮；
   - 顶部「置顶推荐（Spotlight）」区（2~4 坑位自适应双列/多列富卡，0 条有效置顶时自动隐藏），每张卡片携带 Linear 去彩单色 `.status-tag`（`置顶推荐` / `Spotlight`）、作者自荐语（`Maker Note`）、支持平台、版本号与一键安装；
   - 下方「最新上架（Recent Launches）」流，支持 `推荐 / 最新上架 / 讨论热度` 三档 `<SegmentedControl>` 排序切换。
2. **社交脉冲与既有能力复用**：
   - 作者头像（`<CachedAvatar>`）与 `@login` 句柄点击直接呼起 `<DeveloperProfileModal>`（非 GitHub 托管源降级为 `openUrl` 打开作者主页）；
   - GitHub 源卡片一键 Star / Unstar（复用 `tauriApi.starApp` / `unstarApp`，未登录温和提示并可跳转 `#settings-account`），非 GitHub 源隐藏 Star 写按钮降级为源站跳转；
   - 透出相对上架时间、近期发版、本周涨星脉冲（`本周 +N`）、`+1` 顶帖按钮与评论数按钮；未收录条目支持「移入待收录（`onMoveInApp`）」衔接转正链路。
3. **全局平台筛选与数量规范 100% 合规（`docs/count-display.md`）**：
   - 严格响应侧栏 `selectedPlatforms` 多选过滤，筛空时展示带重置入口的 `<FilterEmptyState>`；
   - 通过 `handleLaunchpadPlatformCounts` 向侧栏上报广场全量条目（`spotlight ∪ items`）的平台分布，离开视图恢复全库分布；
   - 标题数量统一使用 `<CountBadge>`，零括号计数、零私有计数类名。

## Scope

- Allowed to modify:
  - `src/views/LaunchpadView.tsx`（新增）
  - `src/views/LaunchpadView/LaunchpadCard.tsx`（新增）
  - `src/views/LaunchpadView/sortLaunchpad.ts`（新增，三档确定性排序纯函数）
  - `src/views/LaunchpadView.test.tsx`（新增）
  - `src/styles/components-launchpad.css`（新增，并在全局样式入口引入）
  - `src/styles/fluent.css`（或现有主样式聚合入口引入 `components-launchpad.css`）
  - `src/app/selectors.ts`（新增 `handleLaunchpadPlatformCounts`）
  - `src/App.tsx`（挂载 `LaunchpadView`、注入 `onOpenDeveloper` / `onOpenAccount` / `onMoveInApp` / 平台分布上报与深链焦点）
  - `src/locales/zh-CN.json`
  - `src/locales/en-US.json`
  - `src/components/components.i18n.scan.test.ts`（将新增视图文件纳入 `MIGRATED_FILES` 零 CJK 硬编码守卫）
- Do not modify:
  - `src/views/FeaturedView.tsx`、`src/views/LatestView.tsx`、`src/views/TrendsView.tsx`
  - `src/components/CountBadge.tsx`

## Implementation Details

### 1. 三档排序纯函数（`src/views/LaunchpadView/sortLaunchpad.ts`）

- `sortLaunchpadItems(items: readonly LaunchpadEntry[], mode: 'recommended' | 'latest' | 'discussions', nowMs?: number): LaunchpadEntry[]`：
  - `'recommended'`：按 Spec §3.3 公式计算时间衰减热度分降序，并列按 `Date.parse(launched_at) DESC`、`id ASC`；
  - `'latest'`：按 `Date.parse(launched_at) DESC`、`summary.stars DESC`、`id ASC`；
  - `'discussions'`：按 `(discussion_comments_count * 2 + discussion_upvotes) DESC`、`Date.parse(launched_at) DESC`、`id ASC`。

### 2. `LaunchpadCard` 视觉与光学规范（`LaunchpadCard.tsx` & `components-launchpad.css`）

- 严格遵守 D4 Linear 去彩单色体系与按钮阶梯规范（`buttons.parity.test.tsx`：相邻操作按钮统一使用 `.btn-fluent .btn-compact`，严禁手写内联 `height` / `padding` 破坏盒模型）：
  - **置顶标注**：Spotlight 卡片标题行挂载 `<span className="status-tag">{t('launchpad.spotlight_tag')}</span>`（复用 `components-status-tag.css`，无彩色底色）；
  - **作者与自荐语区**：
    - `<CachedAvatar src={entry.maker.avatar_url} login={entry.maker.login} size={18} />` + `@{entry.maker.login}` + 相对上架时间；点击头像/句柄 `e.stopPropagation()`，当 `summary.forge === 'github'` 时触发 `onOpenDeveloper(entry.maker.login)`，否则 `tauriApi.openUrl(entry.maker.html_url)`；
    - 自荐语引用块 `.launchpad-maker-note`（2 行截断 `line-clamp: 2`，悬停 `title` 完整显示；英文界面优先读非空 `maker_note_en`）；
  - **底部脉冲与操作栏**：
    - 左侧元信息：支持平台图标组 `<PlatformIcon>`（沿用 `isPlatformLoading` 三态）、版本号标签 `entry.summary.latest_version`、`stars_7d_delta > 0` 涨星徽标；
    - 右侧操作簇（均 `e.stopPropagation()`）：
      1. `+1` 顶帖按钮（`ThumbsUp` / `ArrowBigUp` 13px + `discussion_upvotes` 数字，点击触发顶帖或打开讨论抽屉）；
      2. 讨论按钮（`MessageSquare` 13px + `discussion_comments_count` 数字，点击打开讨论抽屉 `onOpenDiscussion(entry)`）；
      3. 一键 Star 按钮（仅 `forge === 'github'` 渲染：已标星金星 `#eab308`、未标星 `currentColor` + `formatStars(stars)`；非 GitHub 源渲染源仓库外链图标按钮）；
      4. 主安装/启动/查看按钮（与 `AppCard` 同口径：已安装显示已安装/启动，未安装有平台显示「获取」调 `onQuickInstall`，无平台降级为次级「查看」调 `onOpenDetail`）。

### 3. 数量显示与空态分流（`LaunchpadView.tsx`）

- Spotlight 区块：`visibleSpotlight.length > 0` 时渲染标题 `置顶推荐` + `<CountBadge value={visibleSpotlight.length} />`；
- 新品流区块：标题 `最新上架` + `{!loading && !error && <CountBadge value={visibleRecent.length} />}`，右侧放置三档 `<SegmentedControl>`（分段项纯文本，不重复挂数字）；
- 空态优先级：
  1. 网络失败且无缓存（`error && allEntries.length === 0`）→ 错误卡片 + 「重试」按钮；
  2. 原始列表非空但被 `selectedPlatforms` 全部筛除 → `<FilterEmptyState onReset={onResetPlatformFilter} />`；
  3. 原始列表为空 → 空广场引导卡片 + 「提交我的开源作品」主按钮。
- 收到 `is_stale === true` 时，在页顶展示单行轻量离线缓存提示条并提供「刷新」按钮，不阻断浏览。

## Acceptance Criteria

- [ ] 组件单测（`LaunchpadView.test.tsx`）覆盖：
  - Spotlight 置顶卡正确渲染 `.status-tag`「置顶推荐」与作者自荐语，且不重复出现在下方「最新上架」网格；
  - 切换 `推荐 / 最新上架 / 讨论热度` 排序正确重排卡片；
  - 点击作者头像触发 `onOpenDeveloper(login)`；
  - GitHub 源卡片点击 Star 调用 `tauriApi.starApp` / `unstarApp` 并更新星数；Codeberg 源卡片不渲染 GitHub Star 写按钮，点击外链走 `tauriApi.openUrl`；
  - 切换 `selectedPlatforms` 筛空全部条目时渲染 `FilterEmptyState`，侧栏平台分布上报全量未裁剪计数；
  - 中英文切换（`zh-CN` ↔ `en-US`）无残留硬编码中文，英文优先展示 `maker_note_en`。
- [ ] `countDisplay.test.ts`、`noDirectInvoke.test.ts`、`components.i18n.scan.test.ts`、`buttons.parity.test.tsx` 全部通过。
