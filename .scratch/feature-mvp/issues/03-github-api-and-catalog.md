# Issue 03: Catalog 倒排索引检索与 GitHub 直连通信

Status: resolved

## 描述

实现精选收录库与 GitHub 直连服务：
1. 编排 `src-tauri/src/catalog.json`，覆盖 10 大分类、中文别名、精选高星开源软件；
2. 实现本地极速倒排检索（拼音、别名、仓库全称，耗时 < 10ms）；
3. 实现 GitHub REST API 直连调用与 ETag 304 缓存；
4. 支持未收录仓库（`owner/repo`）在线动态解析；
5. 拉取官方 README.md 并改写内嵌图片代理链接。

## Comments

- `catalog.json` 内置 30 款高质量精选开源软件元数据。
- `src-tauri/src/github.rs` 已实现本地倒排匹配、分类筛选、在线仓库解析与 ETag 缓存，单测通过。
