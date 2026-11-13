# Issue 09: 隐私看板展示新信号并可清空反馈

Status: resolved
Blocked by: 02, 08

## 背景

画像新增了已装、浏览、搜索、兴趣种子与负反馈，隐私看板（`AffinityPrivacyRow`）必须同步透明展示并可控。

## 目标

1. 读 `AffinityProfileSummary` 新字段，展示：已安装、浏览、搜索词、兴趣分类（chip 列表）、已屏蔽推荐数。计数遵循 `docs/count-display.md`。
2. 新增「清空推荐反馈」按钮（二次确认），调用 `clear_feed_feedback`，完成后刷新看板。
3. 看板容器加锚点 `id="settings-affinity"`，供精选页偏好入口跳转（跳转方式同 `#settings-account`）。
4. 「一键清空本地画像」的确认文案补充说明会一并清除兴趣分类与推荐反馈。

## 范围（互斥）

- 允许修改：`src/views/SettingsView/*`（仅隐私看板相关文件）、`src/services/api*`（仅新增读口类型字段）、`src/locales/*.json`、`src/demo/tauri-mock.ts`（仅 summary 字段）。
- 禁止触碰：`src-tauri/*`、`src/views/FeaturedView*`。

## 验收标准

- [ ] 单测：新字段缺省（旧后端）时看板不崩，新行隐藏。
- [ ] 单测：清空反馈经确认后才调用命令。
- [ ] `countDisplay.test.ts`、`views.i18n.test.tsx` 通过。
