# Issue 28: 前端重复形状收口（渐变 10+ 处 / remote_url 真值提取 4 处）

Status: resolved
Priority: P3（重复代码）
来源: 2026-10-21 全项目审查 · Standards 轴

## 描述

1. 默认底色渐变 `linear-gradient(135deg,#475569,#334155)` 散写 10+ 处；
   `src/services/custom/mappers.ts:16` 已建常量未共享；Rust 侧
   `catalog_service.rs:576` 同值第三份。
2. `restoreOrFetchIconCycle→remote_url` http 真值提取同形 4 处：
   `src/services/custom/draft.ts:24-26`、`src/views/HomeView.tsx:279-285`、
   `src/app/hooks/useDetailCacheSync.ts:436-441`、
   `src/components/AppDetailModal/Header.tsx:100`。

## 修复方向

- 渐变提为 styles 层 token/类（对齐 D4 状态色 token 化先例），Rust 侧常量注释互指。
- remote_url 提取抽 `resolveRemoteIconUrl(row)` 单函数（放 services/custom），4 处调用。

## Comments

2026-10-21 修复（batch 11）：

1. 渐变 token 化：新建 `src/styles/tokens.ts`（TS 侧 design token，与 tokens.css 同层；icon_bg 是数据值故 CSS 变量不适用），导出 `DEFAULT_ICON_BG`。前端生产 10 处收敛（mappers 删本地常量改导入/selectors/favoritesUncataloged/useDetailCacheSync/catalog.ts×2/demo fixtures/appHelper/board.ts×2）；测试 fixture 保留字面量（独立测试数据，mappers.test 字面量断言继续值守值漂移）。Rust 侧 `github/http.rs` 新增 `DEFAULT_ICON_BG` 常量（含与前端 token 互指注释），8 处字面量全改引用（http 分类表/catalog_service external_synth/catalog_search/catalog_detail/catalog_custom/custom_apps/history 测试 helper）。
2. `resolveRemoteIconUrl` 抽取：新建 `services/custom/iconUrl.ts`（非 string/空白/非 http(s) 一律空串，data: 即时态永不冒充真值），4 处调用（draft.ts 移入收录/HomeView 空图标回填/useDetailCacheSync 双落盘/Header 初次展示跟随）。行为注记：useDetailCacheSync/Header 原实现对非 http 的 remote_url 会直接落盘，现统一走 http(s) 门（对齐文档契约"data: 永不进盘"，hypothetical 分支收紧，实路 remote_url 后端保证 http 或空，无行为变化面）。

验证：tsc --noEmit 绿；pnpm vitest run 76 文件 778 用例全绿；Rust 侧 cargo check --tests 0 err（cargo test/clippy 批次末统一跑）。
