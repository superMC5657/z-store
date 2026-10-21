# Issue 45: normalizeId 深层语义漂移与图标 URL 误归一（35 残项）

Status: resolved
Priority: P2（前端正确性）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · 前端 services 分片

## 描述

35 号要求「enrich 键统一经归一化函数生成」，实现把 `normalizeId` 从
`trim().toLowerCase()` 改成完整 canonical 解析器（`normalizeId.ts:71-146`），
副作用超出工单范围：

- `iconStore.ts:389-405` 用 `normalizeId` 处理图标 **URL**：
  `https://github.com/o/r/a.png` 归一成 `o/r`，非白名单 host 变 `gitea:cdn…/x/y`；
  `normalizeId(url) === norm` 因此会跨不同文件误配，表现为过度失效/重复拉取。
- `matchesForgeHost` 不剥结尾点，而后端 `coord.rs:43` 会剥，
  `https://github.com./o/r` 两侧得到不同 canonical 形态（「一一对应」在边界不成立）。

## 修复方向

- 图标键区分 URL 与 id 两种形态：URL 只做去空白小写比较，id 才走 canonical 解析。
- 前端宿主判定补齐端口/结尾点（与后端同口径）。

## Comments

- `iconStore.ts` 新增 `normalizeIconKey`（URL/`data:` 键 → `trim().toLowerCase()`；
  id 键 → `normalizeId`），`invalidateIconCache`/`getCachedIconDataUri`/
  `isIconPersistedOrQueued`/`queueAssembledRowIcons` 四处改用。
- `normalizeId.ts`：`matchesForgeHost` 补剥 `:port` 与结尾 `.`，默认 host 形式折叠为裸域名。
- 回归：`iconStore.url-keys.test.ts`（同 repo 两个不同 URL 不共享候选键）、
  `normalizeId.test.ts` 补 `github.com:443` / `github.com.` 两例。
- 验证：`vitest` 894 过、`tsc` 绿。
- 提交：caa8f09。
