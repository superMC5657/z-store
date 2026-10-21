# 03: 目录收为单接缝 C4
**What to build:** CatalogService（目录服务）成为唯一域接缝 seam（接缝），上层指令只做薄转发 adapter（适配器），Cache TTL（缓存存活时间）仍仅用于详情，用户视角目录读写表现一致。
**Blocked by:** 02 加深IconFetch C1
**Status:** resolved
- [x] 规范入口 Canonical App Id（规范应用标识）语义不变
- [x] 平台口径与对等回归验证通过

## Comments
- 2026-10-11：代码侧已验证落地（C1-C6），本次对齐票面状态为 resolved。
