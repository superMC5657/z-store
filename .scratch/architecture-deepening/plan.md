# 架构加深开发计划（6 卡片）

报告：`architecture-review-20261011-zh.html`（%TEMP%）。总体结论：C1–C6 已落地，本轮只收其旁路残留，不重开 ADR-0006/0007/0015；仅 14 需决议 ADR-0010。

## 我的逐卡推荐（一句话）

- **09 图标收敛（Strong）**：前后端旁路是同一 IconFetch 缝合的两侧漏水，合并一张票一次收完，先做、解锁 12/14。Phase 1。
- **10 轻量拉取加深（Strong）**：三个逐字重复的 ETag 分支值得一个深模块，消除第 3 份拷贝即可，不动 ADR-0007 豁免语义。Phase 2（与 11 并行，后端/前端写域无交集）。
- **11 pending 生命周期（Strong）**：4+ adapter 已证明缝合值得，纯函数降为内部 seam，定时/seq/inflight 收进一处。Phase 2（与 10 并行）。
- **12 emit 与 rank 收拢（Worth exploring）**：双 save_and_emit 只差一个 gen 全局，合并为 `save_and_emit(ctx, gen)`；compat buffered 按 ADR-0015 原样保留。Phase 3（与 13 并行，09 之后）。
- **13 镜像改写与校验契约（Worth exploring）**：3 份改写留 1 个 interface、校验收拢 fetch→verify，服务 ADR-0004 不重开。Phase 3（与 12 并行，10 之后，同 detail_fetch.rs 先后错开）。
- **14 未收录 join 与规范键（Worth exploring，需决议）**：join 值得收、键三合一无争议，唯 deeplink 收紧 contradict ADR-0010，等 maintainer 决议再动。Phase 4（09+11 之后）。

## 工作图

- Phase 1：09
- Phase 2：10 + 11（并行：后端 commands/github/db vs 前端 lib/hooks/views，无共享文件）
- Phase 3：12 + 13（并行：catalog_search+趋势 vs 镜像/安装/detail 校验段，无共享文件；分别在 09、10 之后）
- Phase 4：14（09+11 之后 + ADR-0010 决议）

## 验证策略（全票通用）

- 后端：`cargo test` + `cargo clippy -- -D warnings`（本仓 CI 红线）。
- 前端：`vitest`（paint-sync、TrendsView.paintSync、App.*.test 单测经同一 interface 走）。
- 原则：interface 即测试面（加深 testing 用 replace-don't-layer：新 seam 接口测试先行，旧旁路删除后旧单测随之删，不迁移）。
- 每票收尾跑对应 seam 的删除测试（票内清单已列）。

## ADR 决议表

| 票 | ADR | 处置 |
|---|---|---|
| 10 | ADR-0007 | 不重开：更新检查继续豁免 TTL，语义写入新模块注释 |
| 12 | ADR-0015 | 不重开：compat buffered 原样保留为唯一 legacy adapter |
| 13 | ADR-0004 | 不重开：fetch→verify 即其契约的收敛实现 |
| 14 | ADR-0010 | **需决议**：修订 ADR 允许 deeplink 归一化，或给 deeplink 记名例外 |
| 09/11 | — | 无冲突 |
