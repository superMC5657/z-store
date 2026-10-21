# Issue 38: 文档-代码漂移整改（license SSOT / 第三池补记 / 术语澄清）

Status: resolved
Priority: P3（文档与测试）
来源: 30 号工单拍板残余（2026-10-21）

## 描述

维护者已拍板（见 30 号工单 Comments），三项落地：

1. **license 名单**（方案：toml 为运行时源 + 测试锁值）：
   - `src-tauri/src/config.rs:245` 注释改口：`DEFAULT_LICENSE_ALLOWLIST` 由「名单唯一
     源头」改为「编译期兜底；运行时源为 config.toml `[license_gate] allowed`，两者
     由测试锁定同值」。
   - 补逐项相等测试：解析嵌入 config.toml 的 `allowed` 与常量逐项相等（现仅
     len/首尾断言，config.rs:681-691，替换或加强）。
   - ADR-0018 §2.1「唯一源头」措辞同步修正。
2. **清单同步第三 Client**（方案：保留独立，补齐 + 补记）：
   - `src-tauri/src/github/catalog_service.rs:40-45` builder 补
     `.connect_timeout(5s)`（对齐双池参数）。
   - ADR-0012 决策 1 增记第三池：清单同步专用（公开静态内容、token 恒不携带）、
     pool_max_idle_per_host 10、connect 5s、timeout 走 `api_timeout_seconds`。
   - CONTEXT.md D5 句尾补一句第三池的存在与理由。
3. **术语双轨澄清**：CONTEXT.md `source=local` 条目补映射说明——合并视图
   `CatalogEntrySource::Custom` 与卡片盖章 `source=local` 为同一 overlay 行的两层
   表达，各自适用面（目录条目枚举 vs AppSummary 投影字段）。

## 修复方向

- 逐项相等测试放 config 现有测试模块；ADR/CONTEXT 文档改动遵循「写现状」规则。
- 三项相互独立，可一张工单一次提交。

## Comments

- 2026-10-21 已落地（commit 49d28dd，30 号拍板方案执行）：
  1. **license 名单**：`DEFAULT_LICENSE_ALLOWLIST` 注释改口为「编译期兜底；运行时源为
     编译进发行的 config.toml `[license_gate] allowed`（serde 缺段回落本常量）」；
     原 `license_gate_defaults_to_d1_strict`（len/首尾抽样）替换为
     `license_allowed_matches_constant_item_by_item` 逐项相等测试（真实跑过，351 全绿）；
     ADR-0018 §2.1「名单唯一源头」措辞同步修正（写现状，含锁测试名）。
  2. **第三 Client 补齐 + 补记**：catalog_service builder 补 `.connect_timeout(5s)`
     （对齐双池参数）；ADR-0012 决策 1 增记第三池（清单同步专用、公开静态内容、
     token 恒不携带、pool 10 / connect 5s / keepalive 60s、超时走
     `api_timeout_seconds`、token 卫生边界理由）；CONTEXT.md D5 句尾补一句。
  3. **术语双轨澄清**：CONTEXT.md `source=local` 词条补映射说明——同一 overlay 行
     双层表达：合并视图条目枚举 `MergedCatalogEntry.source` 为
     `CatalogEntrySource::Custom`（`custom`/`remote`），卡片盖章字段
     `AppSummary.source` 为 `local`/`remote`，投影时 `Custom` 恒映射 `local`，
     各自适用面（目录条目枚举/检索侧 vs 卡片投影字段）。
  4. 验证：`cargo test` 351 过 / `clippy -D warnings` 干净；文档改动遵循「写现状」规则。
