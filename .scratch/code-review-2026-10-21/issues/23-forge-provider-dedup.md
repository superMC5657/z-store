# Issue 23: forge provider 9 处复制分发 + msix 特判双轨

Status: resolved
Priority: P3（重构）
来源: 2026-10-21 全项目审查 · Rust 架构分片

## 描述

1. `src-tauri/src/forge/provider.rs:76` + `mod.rs:22-109`：ForgeProvider trait 从未作
   对象使用，ForgeRegistry 三段 match 复制分发；3 provider × 3 操作共 9 处
   「client + headers + span + 状态检查 + 私有 payload struct + from_counts」同形复制。
2. `src-tauri/src/github/detail_fetch.rs:366-373,382`：msix→setup_exe/windows 特判只
   存在于 GitHub 详情路径，forge 资产（parse_assets）不享受——同一资产分类逻辑双轨。

## 修复方向

- trait 改 `dyn` 对象（方法已无泛型依赖则直接 Box<dyn>），Registry 持
  `Vec<Box<dyn ForgeProvider>>`，分发与同形样板收敛到一处。
- msix/setup_exe 资产分类下沉到共享 parse_assets 路径，GitHub 详情复用。

## Comments

- **trait 对象化**：`ForgeProvider` 三方法由 `async fn`（AFIT，非对象安全）改为
  `BoxFuture<'a, T>` 返回（`futures_util::future::BoxFuture`，既有直接依赖，未新增
  crate）；三家 impl 仅加 `Box::pin(async move { ... })` 包装，方法体逐字未动。
- **Registry 收敛**：`ForgeRegistry` 三段 match（3 操作 × 4 分支）替换为
  `OnceLock<Vec<Box<dyn ForgeProvider>>>` 唯一注册表 + `provider_for(forge_type)` 查找；
  对外关联函数签名不变（updates_check / catalog_detail / catalog_search / commands/forge
  调用方零改动）。search_repos 的 GitHub 分支原传字面量 `"github.com"`，现统一
  `host.unwrap_or(forge.default_host())`——GitHubProvider 本就忽略 host 参数，行为等价。
- **msix 双轨合一**：`provider.rs` 新增 `classify_asset_fields`（classify + `.msix`
  保留 `setup_exe`、`os=all` 归 `windows` 的唯一落点）；`parse_assets` 与 GitHub 详情
  `build_release_assets`（detail_fetch.rs）均改走该单源，detail 内联特判删除。
  行为注记：forge 资产自此与 GitHub 详情同享 msix→setup_exe/windows 分类
  （工单点名的"forge 资产不享受"即此对齐）；其余分类结果逐项不变。
  分类实现细节：`classify_asset` 末分支对未知扩展硬编码 `(Other, "all", "universal")`
  （丢弃已算 arch），msix 落此分支，故 arch 恒为 `universal`——与旧双轨行为一致，
  已在单测注释中锁定。
- **测试**：新增 `classify_asset_fields` msix/常规 exe/未知扩展用例；
  cargo test 357 全绿，`cargo clippy -- -D warnings` 干净（对外行为零变化，纯结构收敛）。
