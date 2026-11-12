# 03: 发现域视图（Home / Trends / Latest / Categories / Favorites）与 AppCard 按钮统一

Status: resolved
Blocked by: 01

## 目标与背景

修复发现域 5 个视图及共享卡片 `AppCard` 中所有同排相邻按钮的高差、字号/图标大小不一、内联样式覆写及激活态反色图标肿胀问题，特别是 `HomeView` Hero 双按钮参数错乱、`AppCard` 底部 `移入收录`/`拉取详情`（`30px`）与 `.btn-install`（`28px`）高差 `2px`、`TrendsView` 裸行按钮 `30px vs 28px`、以及 `FavoritesView` Starred 区域内联覆盖。

## 验收清单

- [x] **`AppCard.tsx`（全发现页 & 收藏页复用）（`src/components/AppCard.tsx:233-268, 362-482`）**：
  - 底部操作区 `move-in-${app.id}` 与 `load-detail-${app.id}` 按钮：移除内联 `style={{ padding: '6px 10px', fontSize: 'var(--font-xs)' }}`，改为 `className="btn-fluent btn-secondary btn-compact"`（严格 **`28px`** 高、`var(--font-sm)` 12px 字号、`0 10px` 内边距），与紧邻的 `.btn-install`（`28px` 高、`var(--font-sm)` 12px 字号）实现 **0px 高差、同字号、同轮廓**！将 `<Inbox>` / `<Download>` 图标调整为 `size={13}` 与 `.btn-install svg`（`13px`）等大。
  - 头部 `.btn-fav-card`（`Watch` 眼睛 & `Favorite` 书签，24×24px）：
    - 激活态 `Watch` 眼睛（`AppCard.tsx:244`）废除整眼实心 `fill="currentColor"`，改为 `fill="color-mix(in srgb, currentColor 16%, transparent)"` 外轮廓 + 仅瞳孔 `<circle cx="12" cy="12" r="3" fill="currentColor" />` 实心点亮，消除实心紫眼遮盖瞳孔与视觉偏大的问题。
    - 激活态 `Favorite` 书签（`AppCard.tsx:262`）施加微缩光学补偿（如 `.btn-fav-card.active svg { transform: scale(0.92); }` 或半透明填充+描边），保持与未激活兄弟按钮一致的视觉体积。
- [x] **`HomeView.tsx`（`src/views/HomeView.tsx:378-416, 471-480, 620-635, 673-685`）**：
  - `.hero-actions` 两颗相邻按钮：彻底删除第 381 行 `style={{ padding: '8px 20px', fontSize: 'var(--font-base)'... }}` 与第 407 行 `style={{ padding: '9px 18px', fontSize: 'calc(13.5px * var(--font-scale))'... }}` 的不一致内联覆盖；统一使用标准 `.btn-fluent`（`30px` 高、`var(--font-base)` 13px、`0 14px`/`0 12px`），并将次按钮 `<ArrowRight size={13} />` 与主按钮 `<Zap size={14} />`/`<Play size={14} />` 统一样式，同时依托 Issue 01 对主按钮反色与内部图标做光学缩比。
  - 最近浏览「清空历史」按钮（`HomeView.tsx:471-479`）：清除内联 `style={{ fontSize: 'var(--font-xs)', padding: '2px 8px', borderRadius: '4px' }}`，改用 `className="btn-fluent btn-secondary btn-sm"`（`26px`）或 `btn-compact`（`28px`），图标 `<Trash2 size={12} />`。
- [x] **`TrendsView.tsx`（`src/views/TrendsView.tsx:491-565`）**：
  - 未收录裸行 `trend-move-in-${item.repo.id}`（第 528-563 行）：删除内联 `style={{ padding: '2px 8px', fontSize: 'var(--font-xs)' }}`，改用 `className="btn-fluent btn-secondary btn-compact"`（`28px` 高），与同榜富卡 `.btn-install`（`28px`）高度对齐，保持与 `.btn-fav-card`（`24px`）居中协调。
  - 裸行 `Watch` / `Favorite` 激活态同步采用与 `AppCard` 一致的光学优化（消除全实心紫眼）。
- [x] **`LatestView.tsx` 与 `CategoriesView.tsx`**：
  - `LatestView.tsx:235-260, 290-295`：空态相邻按钮组 `switch_to_30d` / `switch_to_90d` 统一使用 `.btn-fluent.btn-compact`（或保持 `.btn-sm` 并与 `FilterEmptyState` 协调），受 Issue 01 保护去除 `btn-primary` 反色膨胀感。
  - `CategoriesView.tsx:247-254, 414-416`：清除第 250 行内联 `style={{ gap: '6px' }}`，统一与重试按钮共用 `.btn-sm`（`26px`）或 `.btn-compact`（`28px`）契约。
- [x] **`FavoritesView.tsx`（`src/views/FavoritesView.tsx:131-176, 291-314, 344-364`）**：
  - 顶栏右侧 `.fluent-input-search`（`30px`）与左侧 `SegmentedControl`（`.segmented-group` 总高 `34px`）：调整搜索框或控制带容器对齐基线，或在 FavoritesView 控制带内保持视觉高度协调（如调整 `.segmented-group` 内 `.segmented-item` 与相邻搜索框视觉对齐规则，验证不影响其他 `SegmentedControl` 用例）。
  - Starred 同步区（第 291-313 行）：同排输入框（`28px`）与同步按钮去掉内联 `height: '28px', padding: '0 14px', fontSize: '12.5px'`，直接走 `className="btn-fluent btn-primary btn-compact"`（严格 `28px`），且因 Issue 01 去除外投影与反色光学缩比，与输入框完全齐平。
  - Starred 同步结果操作栏（第 344-364 行）：`全部安装`（`btn-primary`）与 `全部加入收藏`（`btn-secondary`）移除内联 `style={{ fontSize: 'var(--font-sm)', padding: '4px 12px' }}`，统一改用 `btn-compact`（`28px`）或 `btn-sm`（`26px`），图标统一 `13px`/`12px`。
- [x] **回归保护**：
  - 保留 `TrendsView.test.tsx` 中 `.btn-install` 与 `move-in` / `trend-move-in` testid 断言、`HomeView.test.tsx` 与 `FavoritesView.test.tsx` 全部通过。

## Comments

- 2026-11-12：由 `spec.md` 拆出，覆盖发现域全部 5 个视图及共享 `AppCard`。
- 2026-11-12：已完成 `AppCard.tsx`、`HomeView.tsx`、`TrendsView.tsx`、`LatestView.tsx`、`CategoriesView.tsx`、`FavoritesView.tsx` 与 `components-segmented.css` / `components-app-card.css` 改造，`pnpm check` 与 `pnpm build` 通过。
