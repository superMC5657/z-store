# 11: 加深双维筛选 pending 生命周期
**What to build:** 新建 pending-lifecycle 深模块，收编 inflight 集合 + seq 守卫 + lite 批量（5/20）+ settle 定时（15s）+ confirmed 并集，藏于现有 selector interface 之后；`lib/platformFilter` 纯函数降为内部 seam；删除 TrendsView 内 lite/settle 重实现与各视图 3 行 `isPending` lambda（改调统一接口）。
**Blocked by:** 09（同 TrendsView.tsx 先后错开）
**Status:** resolved
- [x] 未收录行 pending→确认语义不变；删除趋势分支后不再出现永久 pending（删除测试）
- [x] 空筛选 `[]` 渲染空状态、缺键回退全选语义保留（CONTEXT 双维目录筛选行）
- [x] `App.platformFilter.test.tsx` 及相关 vitest 经同一 interface 通过

## Comments
- 2026-10-11：已实施并合入 dev-ics2（P2；279 项 vitest 通过、tsc 干净；`[]`/缺键语义由原单测锁定未动）。
- 2026-10-11：票面对齐为 resolved（实现已合入 dev-ics2，见上条记录）。
