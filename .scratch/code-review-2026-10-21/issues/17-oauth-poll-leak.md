# Issue 17: OAuth 设备码轮询卸载后泄漏

Status: resolved
Priority: P2（前端健壮性）
来源: 2026-10-21 全项目审查 · 前端核心分片

## 描述

`src/components/OAuthAccountCard.tsx:53-90`：设备码轮询的 unmount 清理只清当前 timer；
in-flight poll 返回 pending 后 `schedulePoll` 在组件卸载后仍重排，轮询泄漏持续到
deadline（最长十几分钟），期间不断打后端 `oauth_device_poll`。

## 修复方向

- 用 ref 持 `cancelled` 标志（或 AbortController），`schedulePoll` 与 poll 回调入口先查
  标志；unmount 时置位 + 清 timer + abort in-flight。
- 补一个卸载后不再 poll 的单测。

## Comments

- 实现按修复方向取 ref 持标志（`pollCancelledRef`）：unmount cleanup 与
  `handleCancelSession` 置位并清 timer；`schedulePoll` timer 入口、in-flight
  `oauthDevicePoll` 返回后、catch 入口三处先查标志，置位即丢弃结果不重排。
  `handleLogin` 重新登录时复位标志。
- "abort in-flight" 说明：`tauriInvoke` 无 abort 通道，IPC 无法真正中断；采用
  返回后标志拦截（丢弃结果 + 不重排）作为等效手段，泄漏（持续重排打后端）已堵住，
  单次在途请求本身自然结束。
- 附带修复：手动「取消」会话同样存在此泄漏（in-flight pending 返回后仍重排），
  同一标志一并覆盖；并补了「取消后重新登录轮询恢复」的回归断言。
- 测试：`src/components/OAuthAccountCard.poll-leak.test.tsx`（fake timers +
  mock tauriApi），2 用例：unmount 后走完 15min deadline 窗口不再 poll；手动取消后
  不再 poll 且重新登录恢复。`pnpm vitest run` 该文件 2/2 通过。
