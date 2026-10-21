# Issue 04: toggleFavorite 无 catch，unhandled rejection

Status: resolved
Priority: P1（前端正确性）
来源: 2026-10-21 全项目审查 · 前端核心分片

## 描述

`src/App.tsx:534` 的 `handleToggleFavorite` 直接 `await tauriApi.toggleFavorite(...)`，
无 try/catch（对照同文件 :494 的 watch 路径有 catch）。后端 reject 时产生 unhandled
rejection，收藏切换失败 UI 零提示，乐观状态与 DB 分叉。

## 修复方向

- 补 try/catch：失败时回滚乐观收藏态并 toast 报错，对齐 :494 watch 路径的写法。
- 顺带排查 App.tsx 其余 fire-and-forget await（如 :589 handleSelectMirror 直 await
  switchMirror，仅 SettingsView:128 调用侧有 try 兜底，其它复用入口即漏）。

## Comments

- 2026-10-21: `src/App.tsx` `handleToggleFavorite` 补 try/catch：`tauriApi.toggleFavorite` reject 时 toast `toast.favorite_failed` 并 return，收藏集合仅在成功后更新（本就无预先乐观写，失败无需回滚），对齐 watch 路径写法。
- 顺带排查结果：`handleSelectMirror`（App.tsx:589）唯一调用侧是 `SettingsView.handleSaveProxy`（两处 `await onSelectMirror(...)` 均无兜底，工单所述 SettingsView:128 的 try 实为 `handleTestProxy`，不覆盖保存路径）。在 `handleSaveProxy` 整体包 try/catch：失败时不落 `active_mirror`（避免持久化与实际不符）、不给成功反馈，经 `settings.proxy_save_failed` 呈现错误并留存至下次操作。
- 新增 i18n key：`toast.favorite_failed`、`settings.proxy_save_failed`（zh-CN/en-US）。
- 新增 `src/App.toggleFavoriteFailure.test.tsx`：真实 App 路径下 toggleFavorite reject → 错误 toast 呈现、收藏态不翻转；红测验证旧代码以 unhandled rejection 失败。
