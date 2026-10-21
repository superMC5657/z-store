# Issue 43: 设置持久化回滚竞态 + 镜像切换假成功（04/18 残项）

Status: resolved
Priority: P2（前端正确性）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · 前端核心分片

## 描述

18 号要求「失败 toast + 回滚乐观值」，实现存在三处漏洞：

1. `useAppSettings.ts:172` 回滚写的是渲染闭包快照 `settings[key]`，不是函数式 `prev`：
   同一键两次在途保存时，先失败的写入会把后到的值覆盖回更早的值。
2. `handleToggleTheme`/`handleSetTheme` 先改 DOM（`data-theme`），失败后只回滚 state，
   UI 与落库分叉——正是工单要消的形态。
3. `App.tsx:533-540` 的 `handleSelectMirror` catch 不 rethrow，`SettingsView.tsx:172-176`
   继续走成功路径：落 `active_mirror` + 成功反馈，同时 App 已弹错误 toast（一次点击两条矛盾提示）；
   后端 `switch_mirror` 返回 `Ok(false)` 时被完全忽略，被拒镜像静默不生效。

## 修复方向

- 回滚加写入序号守卫：只有最后持有该键的写入可回滚；失败同时回滚视觉副作用。
- 镜像切换失败（含 `false`）必须向上传递，由设置页单一出口提示，不落 `active_mirror`。

## Comments

- `useAppSettings.ts`：新增 `latestWriteSeq`（按 key 计数），回滚与归一回写都以序号为门；
  `applyVisualSetting(key, previous)` 在回滚时同步恢复 `data-theme`/字号/缩放。
- `App.tsx`：`handleSelectMirror` 不再 toast，错误与 `false` 均抛出（后者带描述性 Error）；
  `SettingsView` 的 `proxy_save_failed` 成为唯一提示，失败路径不执行 `onUpdateSetting`。
- 回归：并发双写一失败一成功（终值为后者）、主题失败回滚 DOM、镜像 false/拒绝不落库
  与单条错误提示（`useAppSettings.test.tsx`、`SettingsView.test.tsx`、`App.*.test.tsx`）。
- 验证：`vitest` 894 过、`tsc` 绿。
- 提交：caa8f09。
