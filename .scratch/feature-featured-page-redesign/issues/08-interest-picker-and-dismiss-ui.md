# Issue 08: 兴趣选择卡与「不感兴趣 / 少推这类」交互

Status: resolved
Blocked by: 02, 07

## 背景

冷启动引导与负反馈的前端入口（spec §2 卡片菜单、§3 兴趣选择卡）。

## 目标

1. API：`saveInterestSeeds({ categories })`、`getInterestSeeds()`、`dismissFeatured({ target, scope })`、`clearFeedFeedback()`。
2. 兴趣选择卡（`cold` 状态占 hero 位）：10 个分类 chip 多选；未选时点保存给出行内提示而不禁用按钮；保存后重拉页面；「跳过」后本会话不再显示（内存态，不落库）。
3. 卡片悬停菜单（hero 与货架卡片，主流卡片不加）：「不感兴趣」→ `scope=app`；「少推 {分类}」→ `scope=category`。点击后卡片就地淡出，货架不补位、不重排；失败时恢复卡片并 toast。
4. 键盘可达：菜单可用 Tab / Enter 打开，Esc 关闭。
5. 演示站 mock 实现以上命令（内存态）。

## 范围（互斥）

- 允许修改：`src/views/FeaturedView*`、`src/components/AppCard*`（仅菜单插槽）、`src/services/api*`、`src/demo/tauri-mock.ts`、`src/locales/*.json`、`src/styles/*`。
- 禁止触碰：`src-tauri/*`、`src/views/SettingsView/*`。

## 验收标准

- [ ] 单测：点击「不感兴趣」以正确 camelCase 参数调用 `dismiss_featured`，卡片从 DOM 移除且其余卡片顺序不变。
- [ ] 单测：调用失败时卡片恢复。
- [ ] 单测：兴趣选择卡未选直接保存出现行内提示且不发请求。
- [ ] `ipcArgsNaming.test.ts` 通过。
