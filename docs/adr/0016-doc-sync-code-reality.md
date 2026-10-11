# ADR-0016：文档追齐代码差异与决策（以代码为准）

- 状态：Accepted
- 日期：2026-10-11
- 关联：ADR-0014（趋势榜 L2）§1、ADR-0015（统一图标获取）、CONTEXT.md D2/D9/D10、`docs/logging.md` §4/§6/§8、`README.md` 技术栈与 M1 行
- 前提：只改 `*.md`，不动 `src/`、`src-tauri/`、`scripts/` 代码/配置/锁文件；每个修正均有 `path:line` 代码证据；历史 ADR（0001-0015）保持 Accepted 不重写。

## 1. 逐项核实结论（a–g）

### a) DB 表数量：文档 14 表 vs “代码 13 表”之说——以代码为准是 14 表

- `src-tauri/src/db/schema.rs:8-131` 共 14 个 `CREATE TABLE`：`installed_apps` / `api_etag_cache` / `app_details_cache` / `user_settings` / `user_favorites` / `update_rules` / `search_history` / `view_history` / `host_tokens` / `watched_apps` / `user_stars` / `icon_cache_meta` / `app_icon_cycles` / `trend_board_cache`。
- 无 `search_result_cache` 表（与 ADR-0014 §1 “全局 14 张核心表，`search_result_cache` 不存在”一致）。
- 决策：**文档原 “14 表”正确，不改数量**；仅在 CONTEXT D2 / README / logging §8 补全 14 表清单与 `schema.rs:8-131` 引用，消除未来 “13 vs 14” 误读。任务背景中 “代码 13 表” 的说法经 `grep CREATE TABLE` 复核不成立（`Count = 14`）。

### b) 版本号 / 技术栈版本：三处 `0.6.1` 对齐，栈版本按下述 pin

- `package.json:4` / `src-tauri/Cargo.toml:3` / `src-tauri/tauri.conf.json:4` 均为 `0.6.1`（由 `scripts/bump-version.mjs` 同步四文件，含 `Cargo.lock`）。
- 前端：`@tauri-apps/api ^2.2.0`（`package.json:18`）、CLI `^2.2.0`（`package.json:29`）、`i18next ^26.4.2`（`package.json:21`）、`react/react-dom ^19.0.0`（`package.json:24-25`）、`typescript ^5.7.3`（`package.json:36`）、`vite ^6.2.0`（`package.json:37`）、`pnpm 10.33.0`（`package.json:6`）、`vitest ^3.2.4`（`package.json:38`）。
- 后端：`tauri = "2"`（`Cargo.toml:17`）、`tokio full`（`Cargo.toml:23`）、`reqwest 0.12`（`Cargo.toml:24`）、`rusqlite 0.32 bundled`（`Cargo.toml:26`）、`edition 2021`（`Cargo.toml:6`）；仓库内未 pin Rust 工具链版本。
- 决策：README “Tauri 2.2 + Rust 1.77+ / React 19 + TS 5.7 + Vite 6” 改为上述精确引用；删除 “Rust 1.77+” 的隐含 MSRV 宣称（无工具链文件，以 `edition 2021` 为准）。

### c) Tauri commands：`lib.rs:527-602` 共 74 个

- 72 个 `commands::*` + 2 个 `z_log::*`（`zlog_get_dir` / `zlog_export_bundle`）；`fetch_trends_text` / `get+save_trend_board_cache` / `oauth_device_start+poll` / `get_oauth_user` / `oauth_logout` 均在注册表内（`lib.rs:551-553,592-595`）。
- 决策：文档不再用 “约 70” 模糊计数；README/CONTEXT 统一写 “74 个 commands（含 2 个 zlog）”，证据 `lib.rs:527-602`。

### d) 前端结构：7 视图 + IPC 唯一出口，旧路径之说不成立

- `ViewType` 7 种（`src/types/index.ts:143`：`home|trends|categories|favorites|installed|updates|settings`），`App.tsx:57` 用 `useState` 视图机（无 router）；`src/views/` 下 7 视图目录 + `ViewShell` + `useViewFilter`。
- IPC 唯一出口：`src/services/api.ts:119-190` CMD 表 + `src/services/api/client.ts:1-10`（`tauriInvoke` / `isTauri`）；`src/services/client.ts` 在仓库内**不存在**（以 `fd` 为准）；视图禁直调 `invoke`（`src/views/noDirectInvoke.test.ts`）。
- `AppIcon.tsx`（`src/components/AppIcon.tsx`）、`BrandLogo.tsx`（`src/components/BrandLogo.tsx`）、`Header.tsx`（`src/components/AppDetailModal/Header.tsx`）、`iconStore.ts`（`src/services/iconStore.ts:279 applyHit`）、`searchListCache.ts`（`src/services/search/searchListCache.ts`）均存在。
- 决策：文档引用一律用上述实际路径；不再提 “Header.tsx/AppIcon.tsx/BrandLogo.tsx 旧路径已删除” 这类说法（与 `fd` 结果矛盾）。

### e) 后端模块：无重组，文档路径均有效

- `src-tauri/src/github/icon_fetch.rs`（`fetch_icons_stream` 见 `:199`，`emit_icon_ready` 见 `:112-113`）、`github/icon_probe.rs`、`github/catalog_service.rs`（`CatalogService`）、`forge/http.rs`、`installer/*`、`scanner/*`、`forge/*`、`oauth/*`、`log_support.rs` 均存在（`fd` 已列）。
- 决策：CONTEXT D10 把 `github/icon_fetch.rs` 补为 `src-tauri/src/github/icon_fetch.rs:199` 全路径引用；其余不改。

### f) 配置 / 脚本：文档值与代码一致；“不存在”之说仍准确

- `src-tauri/config.toml`：`detail_ttl_minutes=30`、`connect/download/chunk/api` = `15/300/30/12`（`config.rs:26-62` 同值兜底）、`ping_timeout_ms=4000`、`search/view` 历史 `20/30`、页 `12`（`config.rs:126-133`）、`default_client_id="Ov23lik0b7fDGMLTiOYH"`；`IconFetch pool=5`（`config.rs:106-110`）。
- `tauri.conf.json`：`devUrl 1420` + HMR `1421`（`vite.config.ts:13-31`）、无边框 `1280x860`（`:16-29`）、CSP（`:30-33`）、NSIS `currentUser`（`:48-54`）、updater 双 endpoint（`:58-64`）。
- `scripts/` 仅 `build-latest-json.mjs` + `bump-version.mjs`；`sync:catalog` / `validate-catalog.mjs` 在代码内无匹配（`grep` 为空），“明确不存在”仍准确。
- 决策：README 配置段补上述 `path:line` 引用；脚本段不新增文档宣称。

### g) M1 PWA：仓库内无 PWA 痕迹，改“推进中”为“规划中（未启动）”

- `fd manifest|service-worker|workbox|vite-plugin-pwa` 仅命中 updater 语义的 `src/utils/updateManifest.ts` 与 ADR 文本，无 `vite-plugin-pwa` / `manifest.webmanifest` / service-worker。
- 决策：README M1 行改为 “规划中（未启动）”，并注明无 PWA 产物（本 ADR 为证据）。

## 2. logging.md 勘误（`z_log.rs` + `src/lib/z-log.ts` 为准）

- §4：前端实际导出只有 `zlogInfo / zlogWarn / zlogError` + `initZLog`（`src/lib/z-log.ts:62-86`）；**无 `zlogDebug`、无 `flush()`、无导出的 `isInitialized`**（后者为内部变量）。另有 `[sid]/[req]` 前缀（`withPrefix`）与 1s 去重窗（`DEDUP_WINDOW_MS=1000`，`z-log.ts:48-59`）。已按此修正。
- §6：prune 判定以 `z_log.rs:395-405` 为准（文件名小写 `.log` / `.log.bak` 后缀或扩展名 `log`/`bak`）；`KEEP_DAYS=14`（`:11`）、`MAX_TOTAL_BYTES=25MB`（`:13`）、单文件 5MB（`:16`）+ `KeepSome(5)`（`:18`）。已补行号。
- §11 `log_support::sanitize_url` 引用有效（`src-tauri/src/log_support.rs` 存在）。

## 3. 趋势榜 FE/BE 上限（D9 证据补齐）

- FE 256KB：`TREND_DB_PAYLOAD_MAX_BYTES = 256*1024`（`src/services/trends/cache.ts:32-33`），写前预检降级（`:336`）。
- BE 512KiB：`TREND_BOARD_CACHE_MAX_BYTES = 512*1024`（`src-tauri/src/db/cache.rs:215`），超限拒绝（`:249`）。
- 榜 L2 双档 daily 1h / 其余 12h（`cache.ts:18-21`），有效 TTL 扣抖动（`:53-62`），429 上限 60s / 缺省 5s（`:23-26`）；`boardReady`（`useTrendBoard.ts:86`）、`swrSyncedResult` / `isUpgradePending`（`TrendsView.tsx:314-325`）仅门控富卡升级。

## 4. 未改动

- ADR-0001–0015 保持 Accepted 原文，未加勘误注（复核 0014 §1 表数量、0015 §1–§2 接口/事件与代码一致，无需注记）。
- 单上下文布局不变（`CONTEXT.md` + `docs/adr/`），术语沿用词汇表，中文为主。
