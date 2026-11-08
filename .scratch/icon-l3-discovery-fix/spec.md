# Feature Spec: 富卡列表与详情页 L3/L4 多级图标探索一致性修复（Icon L3 Discovery Fix）

> 状态：Implemented（`resolved`）
> 关联契约：`CONTEXT.md`（D6 有限并发、D8 首包验图与跳过、D9 趋势与首页、D10 统一图标获取）、ADR-0010（规范应用标识 `Canonical App Id`）、ADR-0014（趋势 L2 与治理）、ADR-0015（统一图标获取与搜索对齐）。

---

## 1. 问题背景与根因诊断

在趋势榜（`TrendsView`）以及在线搜索（`search_apps_online`）展示未收录 GitHub 仓库的富卡列表（`AppSummary`）时，部分应用无法展示 L3（仓库 Git Trees）图标（仅显示 L5 首字母缩写徽章），但点击进入应用详情（`AppDetail`）后又能找到并展示“L3”图标。经对代码链路与真实运行库（`z_store.db` / `ZStore.log`）取证，定位出以下 4 个正交根因：

### 1.1 根因一：详情页将 L4（README 头部 Logo）误判为 L3（仓库文件图标）落库
- **现状**：
  - 列表流式补探核心 `IconFetch`（`src-tauri/src/github/icon_fetch.rs::fetch_icons_stream` → `probe_single_live`）按 ADR-0015 设计**仅探测 L2（SimpleIcons 品牌库）与 L3（Git Trees 仓库文件树）**，不拉取 README（L4 为详情链专属）。
  - 详情页 `CatalogService::fetch_app_detail`（`src-tauri/src/github/detail_fetch.rs`）在 L2/L3 未命中时，会调用 `CatalogService::extract_and_strip_logo_from_readme`（`src-tauri/src/github/markdown.rs`）从 README 前 40 行提取首部图片（真实级别为 **L4**）。
  - 但 `extract_and_strip_logo_from_readme` 内部先经 `clean_image_url` 将 GitHub `/blob/` 链接与相对路径改写为 `https://raw.githubusercontent.com/...`（相对路径改写为 `.../HEAD/...`）或保留外部图床 URL；随后详情落库函数 `persist_github_detail`（`src-tauri/src/commands/catalog_detail.rs:850`）与 `get_or_fetch_icon`（`src-tauri/src/commands/icons.rs:348`）仅凭 URL 字符串调用 `level_for_detail_icon`（`src-tauri/src/github/icon_fetch.rs:108-116`）反推档位：
    ```rust
    pub(crate) fn level_for_detail_icon(icon_trimmed: &str) -> i32 {
        if icon_trimmed.contains("simpleicons.org") {
            2
        } else if icon_trimmed.contains("/blob/") || icon_trimmed.to_lowercase().contains("readme") {
            4
        } else {
            3
        }
    }
    ```
  - 由于 `clean_image_url` 已剥除 `/blob/`，几乎所有从 README 提取的 L4 图片（如外部图床 `vercel-storage.com`、`media.x.ai` 或相对路径改写的 `raw.githubusercontent.com/.../HEAD/...`）均被误判为 `level = 3` 写入 `app_icon_cycles.l3_url`（而 `l4_url` 留空）。
- **后果**：
  1. 本身只有 L4（README）图片而无 L3（仓库树）图标的应用，在列表页因不探 L4 而无图，进详情页提取出 L4 后却被标为 L3 展示；
  2. 因 L4 被错塞入 `l3_url` 且 `l4_url` 为空，未收录应用在详情页手动轮换时跳过 L4，表现为只有 `L2 -> L3 -> L5` 三档。

### 1.2 根因二：`verify_image` 对 L2 404 未短路 + `probe_l3_trees` 冗余查分支且无 `"HEAD"` 兜底
- **现状**：
  1. **L2 SimpleIcons 404 三连请求放大**：`src-tauri/src/github/icon_probe.rs::verify_image` 在第 1 步 `HEAD` 请求收到 `404 Not Found`（或 `410 Gone`）时未立即返回 `None`，而是继续回退执行第 2 步 `fetch_range_head`（Range GET，再次 404）和第 3 步全量 `GET`（第三次 404）。每个未收录仓库派生 2～4 个候选 slug，进入 L3 前需先串行耗费 6～12 次无意义的 CDN 404 请求，严重阻塞 `fetch_icons_stream` 的 `pool = 5` 并发池。
  2. **L3 分支查询冗余且无兜底**：`src-tauri/src/github/icon_fetch.rs::probe_l3_trees` 每次都调用 `resolve_probe_branches` 发起一次无 ETag 缓存、无重试的 `GET https://api.github.com/repos/{owner}/{repo}` 查询 `default_branch`（尽管趋势 enrich 的 `fetch_online_repo` 刚请求过同一接口却丢弃了 `default_branch`）。在首屏 60+ 并发请求突发下，一旦该请求超时或失败返回空数组，`probe_l3_trees` 直接放弃 L3；而详情页 `fetch_app_detail` 复用了带 ETag 的 `repo_info.default_branch`，且失败时回退 `"HEAD"` 分支（`unwrap_or_else(|| "HEAD".to_string())`），故详情页总能探出 L3。

### 1.3 根因三：趋势榜 `useTrendEnrichment` 连环重入递增 `BOARD_GEN`，强行杀死在途 `fetch_icons_stream`
- **现状**：
  - `src/views/TrendsView/useTrendEnrichment.ts:157-194` 的 enrich `useEffect` 依赖了 `displayItems`，而 `src/views/TrendsView.tsx:285-298` 中 `displayItems` 依赖 `enrichedApps` 与 `combinedConfirmed`。
  - 当同榜 20 个仓库中有任一仓库在 `fetch_online_repo` 失败返回 `None`（如仓库改名/404/超时），其余成功仓库调用 `setEnrichedApps` 会更新 `displayItems` 引用并立即重触发该 `useEffect`；此时 `collectMissingEnrichRepos` 发现失败仓库仍不在 `enrichedApps` 中（`missing.size > 0`），立即发起第二次 `enrich_trend_repos` 调用。
  - 后端 `enrich_trend_repos`（`src-tauri/src/commands/catalog_search.rs:718`）每次调用都会递增全局 `BOARD_GEN`，导致上一轮正在后台为其余 19 个仓库探测 L3 图标的 `fetch_icons_stream` 触发 `should_stop` 提前中止，且已在途完成的探测在 `save_and_emit` 中因 `current_emit_gen != expected_gen` 被抑制发射（`icon emit suppressed`）。

### 1.4 根因四：确认图标（`Confirmed Icon`）回填 `data:` Base64 后未进 M1 缓冲 + 大小写 ID 未归一
- **现状**：
  1. **确认图标 `data:` 未注入 M1 缓冲且被缓存层剥空**：当应用已有落盘图标时，`resolve_confirmed_icon_from_db` 返回 `data:image/...;base64,...`，且后端 `enrich_trend_repos` 见 `pre_confirmed.is_some()` 跳过 `fetch_icons_stream`。但前端 `enrichTrendReposCore`（`src/services/trends/enrich.ts:488`）遇到 `s.icon.startsWith('data:')` 时既未调用 `admitIconHit` 写入 `iconStore` 的 M1 缓冲（`iconById`），又直接 `return` 跳过写入 `trendEnrichCache`；随后 `maybePersistLitePatched` / `confirmLiteEmpty` / `buildSettleHydration` 在落盘时将 `data:` 剥空为 `icon: ''` 写入 `trendEnrichCache` 与 `trend_board_cache`。当后续命中 `trendEnrichCache` 或重挂时，若 M1 缓冲无记录且未触发二次回填，卡片即退化为空徽章。
  2. **`fetch_online_repo` 与 `get_or_fetch_icon` 大小写 ID 未归一**：`CatalogService::fetch_online_repo`（`src-tauri/src/github/search.rs:305`）生成的 `AppSummary.core.id` 为未转小写的 `format!("{}/{}", owner, repo)`，违反 ADR-0010 `Canonical App Id` 小写契约；同时 `get_or_fetch_icon`（`src-tauri/src/commands/icons.rs:272, 342`）未对 `app_id` 做 `canonical_app_id` / `lookup_case_insensitive` 归一，导致查表 Miss 重下并在 `app_icon_cycles` 产生大小写重复行。

---

## 2. 修复目标与设计方案

### 2.1 保真详情图标来源级别（L2/L3/L4）与 `Canonical App Id` 归一（Issue 01）
1. **详情探测真实来源透传与双槽补齐**：
   - 在 `src-tauri/src/github/detail_fetch.rs` 与 `src-tauri/src/db/icon_cycle.rs` 中，保留 `probed_hit`（`"simple-icons"` → L2，`"trees"` → L3）与 `extracted_logo`（README → L4）的真实来源级别。
   - 在 `persist_github_detail`（`src-tauri/src/commands/catalog_detail.rs`）落库 `app_icon_cycles` 时：
     - 若选中图标来自 README 提取（`extracted_logo`），显式以 `level = 4` 调用 `merge_detail_icon` 写入 `l4_url`（绝不写入 `l3_url`）；
     - 若 `probed_hit`（L2 或 L3）与 `extracted_logo`（L4）同时命中，主选中按优先级走 L2/L3，同时调用 `fill_probe_slot(&mut cycle, 4, &l4)` 顺手将 L4 备选 URL 填入 `cycle.l4_url`，使详情页轮换无需二次探测即可完整覆盖 `L2 -> L3 -> L4 -> L5`。
2. **`level_for_detail_icon` 与 `get_or_fetch_icon` 槽位识别加固**：
   - `AppIconCycle` 新增辅助方法 `level_for_known_url(&self, url: &str) -> Option<i32>`：若 URL 已存在于当前行的 `l2_url` / `l3_url` / `l4_url` 槽位中，优先返回对应槽位级别（防止 `get_or_fetch_icon` 下载已知 L4 图片时被重新误判为 L3）。
   - `level_for_detail_icon` 除 `/blob/` 与 `readme` 外，将 `clean_image_url` 相对路径改写特征（`raw.githubusercontent.com/.../HEAD/...`）及非 `raw.githubusercontent.com` / 非 `simpleicons.org` 的 GitHub README 常见图床（`user-images.githubusercontent.com`、`camo.githubusercontent.com`、`github.com/user-attachments/assets/`）统一归为 `4`（L4）。
3. **强制 `Canonical App Id` 小写归一（ADR-0010）**：
   - `CatalogService::fetch_online_repo`（`src-tauri/src/github/search.rs:305`）构造 `fallback_summary` 时，将 `id` 统一为 `crate::forge::canonical_app_id_from_parts(owner, repo)`（小写 `owner/repo`）。
   - `get_or_fetch_icon`（`src-tauri/src/commands/icons.rs`）与 `load_or_new_cycle`（`src-tauri/src/commands/icons_cycle_probe.rs`）对入站 `app_id` 统一经 `crate::forge::canonical_lookup_id` 归一化后再读写 `app_icon_cycles`，消除大小写重复行与缓存查表 Miss。

### 2.2 `verify_image` 404 快速短路与 L3 分支透传/兜底（Issue 02）
1. **`verify_image` 对确定性 404/410 立即短路**：
   - 在 `src-tauri/src/github/icon_probe.rs::verify_image` 中：当第 1 步 `HEAD` 响应状态码为 `404 Not Found` 或 `410 Gone` 时，**直接返回 `None`**，不再发起后续 `fetch_range_head`（Range GET）与全量 `GET`；
   - 当第 2 步 `fetch_range_head` 收到 `404 Not Found` 或 `410 Gone` 时，同样**直接终止并返回 `None`**，仅在服务器不支持 `HEAD`/`Range`（如 `405`/`501` 或网络/协议错误）时才回退全量 `GET`。
2. **已知 `default_branch` 进程内记忆 + `"HEAD"` 兜底**：
   - `OnlineRepoResponse` 与 `OnlineSearchItem`（`src-tauri/src/github/search.rs`）反序列化保留 GitHub API 已返回的 `default_branch: Option<String>`，并经 `remember_repo_default_branch` 写入 `icon_probe` 的有界进程内缓存（`KNOWN_DEFAULT_BRANCHES`）。
   - `resolve_probe_branches`（`src-tauri/src/github/icon_probe.rs`）：优先命中 `known_repo_default_branch`，未命中时调 `GET /repos/{owner}/{repo}` 拿到非空 `default_branch` 返回 `vec![default_branch]`；当请求超时/失败或字段缺失时，回退返回 `vec!["HEAD".to_string()]`（对齐 `detail_fetch.rs:654` 的 `"HEAD"` 兜底语义，因为 GitHub `/git/trees/HEAD?recursive=1` 与 `raw.githubusercontent.com/{owner}/{repo}/HEAD/...` 原生支持 `HEAD` 解析默认分支），确保单次元数据请求抖动不会导致 L3 被整仓跳过。

### 2.3 趋势榜 `useTrendEnrichment` 世代防自杀与确认图标 M1 协同（Issue 03）
1. **阻断同榜 `enrichTrendRepos` 连环重入（保护后端 `BOARD_GEN` 与在途 `fetch_icons_stream`）**：
   - 在 `src/views/TrendsView/useTrendEnrichment.ts` 中，维护当次榜单加载周期内已发起过 enrich 请求的坐标集合 `attemptedEnrichKeysRef`（当 `trendResult` 引用变化、切换 `activeBoard` 或手动刷新 `refreshEnrichForceRef.current === true` 时重置清空）。
   - 在 `boardReady === true` 前不提前消耗/取消；一旦对缺失集合发起 `enrichTrendRepos`，将对应键记入 `attemptedEnrichKeysRef`，且 effect 不再将随图标/平台状态高频变动的 `displayItems` 作为触发取消在途 `enrichTrendRepos` Promise 的依赖，改为仅依赖 `[trendResult, activeBoard, trendFetchOpts, boardReady]`（从 `trendResult.repos` 与 `enrichedAppsRef.current` 收集未尝试过的未收录仓）。
   - 这样即使同榜某 1 个仓库在后端 `fetch_online_repo` 404/超时返回 `None`，也不会触发二次 `enrich_trend_repos` 调用，保证每次榜单加载只递增一次 `BOARD_GEN`，让后台 `fetch_icons_stream` 完整跑完所有 L3 探测。
2. **确认图标（`Confirmed Icon`）回填链 M1 缓冲与远端 URL 协同**：
   - 在 `src/services/trends/enrich.ts::enrichTrendReposCore` 中：当后端返回的 `s.icon` 非空（含 `data:` 确认图标或 `http(s)` URL）时，通过 `admitIconHit({ id: key, icon: s.icon, via: 'm2' })` 同步注入 `iconStore` 的 M1 内存缓冲（`iconById`），确保后续 `maybePersistLitePatched` / `confirmLiteEmpty` / `buildSettleHydration` 将持久化副本的 `data:` 剥空为 `''` 后，列表组件 `AppIcon` 与 `resolveIconWithBuffer` 仍能从 M1 缓冲中命中该确认图标直显，不退化为空徽章（同时保持 `snapshotTrendEnrichCache` 不含 `data:` 的既有契约不变）。
   - 在 `src/views/TrendsView/useTrendEnrichment.ts` 中：当 `enrichTrendRepos` 落定合并后若仍有空图标项（例如命中了 L1/L2 缓存中 `icon: ''` 的条目），补充触发一次 `getConfirmedIconsBatch`（DB-only 零网络）回填。

---

## 3. 实施 Issue 拆分清单

- [`01-detail-icon-level-origin-and-canonical-id.md`](file:///z:/rust_workplace/z-store/.scratch/icon-l3-discovery-fix/issues/01-detail-icon-level-origin-and-canonical-id.md)：详情页图标真实层级（L2/L3/L4）保真落槽、L4 备选槽同步填充与 `Canonical App Id` 小写归一。
- [`02-icon-probe-404-shortcircuit-and-branch-fallback.md`](file:///z:/rust_workplace/z-store/.scratch/icon-l3-discovery-fix/issues/02-icon-probe-404-shortcircuit-and-branch-fallback.md)：`verify_image` 对 404/410 立即短路 + `resolve_probe_branches` 失败回退 `"HEAD"` 兜底。
- [`03-trend-enrich-gen-stability-and-m1-admit.md`](file:///z:/rust_workplace/z-store/.scratch/icon-l3-discovery-fix/issues/03-trend-enrich-gen-stability-and-m1-admit.md)：趋势榜 `useTrendEnrichment` 防连环重入（保护 `BOARD_GEN` 流式探测）与确认图标 M1 缓冲注入。
- [`04-docs-and-regression-verification.md`](file:///z:/rust_workplace/z-store/.scratch/icon-l3-discovery-fix/issues/04-docs-and-regression-verification.md)：`CONTEXT.md` / `ADR-0015` 文档同步与前后端全量门禁回归验证。
