# Feature Spec: 趋势榜（Trends Board）

> 状态：已落地；契约以 ADR-0014（榜 L2 与治理）与 ADR-0015（统一图标获取）为准，Issue 明细见本目录 `issues/`。

## 1. 目标与范围

- 趋势榜单展示与 L2 落盘缓存治理（分档 TTL、容量上限、清扫对齐）。
- 富卡 enrich 正确性：批量上限、保序等齐、慢尾处理（以 ADR-0014/0015 为准）。

## 2. 实施 Issue 清单

- `01-sqlite-migration-user-version.md`：SQLite 迁移基线。
- `02-rust-db-hardening.md`：Rust 侧 DB 加固。
- `03-frontend-l2-governance.md`：前端 L2 治理。
- `04-enrich-correctness.md`：enrich 正确性。
- `05-scoring-convergence.md`：打分收敛。
- `06-cleanup-tails.md`：收尾清理。
