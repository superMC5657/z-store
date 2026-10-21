# Issue 30: 文档-代码漂移：license 双名单 / 第三 Client 未记录 / 术语双轨

Status: resolved
Priority: P3（规格偏差）
来源: 2026-10-21 全项目审查 · Spec 轴

## 描述

三处代码与文档声明不符，其中两处需要维护者拍板方向：

1. **ADR-0018 §2.1**「名单唯一源头为 DEFAULT_LICENSE_ALLOWLIST，不各自手写」：实际
   `src-tauri/src/config.rs:246` Rust 常量与 `config.toml:46-49`（37 条）两份手写；
   运行时门禁读嵌入 toml（config.rs:550-552），两份仅有 len/首尾断言
   （config.rs:681-691），无逐项相等测试，可静默漂移。
2. **D5/ADR-0012 双池隔离**：`src-tauri/src/github/catalog_service.rs:39-48` 自建第三
   个 HTTP Client（pool=10、无 connect_timeout/idle 配置）供清单同步（:315）——任何
   文档未记此池。是补记 ADR-0012（三分池）还是回归双池，需要决策。
3. **CONTEXT.md 词汇表双轨**：同一 overlay 行在合并视图标 `source=custom`
   （CatalogEntrySource::Custom），在 AppSummary 盖章标 `source=local`；`custom` 与
   `local` 两条目并存但未说明各自适用面。

## 待决策 / 修复方向

1. 单名单：以 config.toml 为 SSOT、Rust 常量删除；或反向。无论方向，补逐项相等测试
   锁住（此半无需决策，可直接做）。
2. 第三 Client：倾向收敛回共享池；若保留（隔离清单同步流量有其合理性），补 ADR 增记。
3. 词汇表：在 `source=local` 条目补一句与 `CatalogEntrySource::Custom` 的映射关系。

## Comments

- 2026-10-21 维护者拍板（读码核实后）：
  1. **第三 Client 保留独立**：清单同步拉取公开静态内容（raw.githubusercontent.com，
     无 token），独立通道构成 token 卫生边界，与 ADR-0012 双池哲学同构；处置为
     「补齐 + 补记」——补 `connect_timeout 5s`，ADR-0012 增记第三池，CONTEXT.md D5
     同步（→ 38 号工单）。
  2. **license 名单 SSOT 定为 config.toml**：承认现状（运行时读嵌入 toml），常量
     `DEFAULT_LICENSE_ALLOWLIST` 改口为编译期兜底；补逐项相等测试锁同值，改
     config.rs:245 注释与 ADR-0018 §2.1 措辞（→ 38 号工单）。
  3. 术语双轨无需决策，随 38 号一并澄清。
- 全部残余动作拆至 `38-doc-drift-remediation.md`。
