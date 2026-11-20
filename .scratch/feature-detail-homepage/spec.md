# Feature Spec: 应用详情弹窗官方主页外链展示与单色视觉统一（App Detail Modal Official Homepage Entry）

> 状态：Implemented
> 关联契约：`CONTEXT.md`（领域词汇表：`应用详情 AppDetail`、`应用概要 AppSummary`、`精选收录库 Curated Catalog`、`本地库 Local Library`、`托管源提供者 ForgeProvider`、`Fluent 2 矢量图标体系`；核心原则：`D2 零服务器成本与解耦清单同步`、`D4 Linear 去彩单色界面`）、ADR-0001（Tauri 2 + React 19 + Linear 去彩单色与 Fluent 矢量图标架构）、ADR-0006（多源代码托管平台生态支持）、ADR-0010（规范应用标识 `Canonical App Id`）。

---

## 1. 背景与代码现状排查结论

应用模型（后端 `src-tauri/src/models.rs::AppCore`、前端 `src/types/index.ts::AppSummary` / `AppDetail`、`catalog.json`、`catalog_apps`、`custom_apps`、`app_details` 与 `repo_card_cache`）均已携带 `homepage: Option<String>` / `string | null` 字段，但**应用详情（`AppDetailModal`）顶部信息区（`src/components/AppDetailModal/Header.tsx`）尚未向用户暴露「官方主页」外链入口**。

经对全链路代码、内置 `catalog.json` 真实数据与现有测试门禁的逐层排查，定位到以下 **5 项关键现状与边界问题**，必须在实现与测试中一并闭环：

### 1.1 清单与多源仓库数据中存在大量「主页等同于代码仓库地址」及异构 URL 写法
- 在 `catalog.json` 中存在两类截然不同的仓库级 URL：
  - **等同于当前仓库地址（应隐藏，避免与左侧 `{repo} ↗` 重复）**：如 `BurntSushi/ripgrep`（`"homepage": "https://github.com/BurntSushi/ripgrep"`，大小写与 canonical id 不同）、末尾斜杠 `/`、`http://` 协议、`www.github.com`、`.git` 后缀、`#readme` 锚点、`?tab=readme-ov-file` 参数，以及 `TrendsView.tsx:517` 未富化行默认填入的 `homepage: item.repo.url`（即当前仓库 URL 本身）与 Codeberg / Gitea / GitLab / 自建端口实例（如 `https://git.example.com:8443/org/app`）的同仓地址；
  - **同托管平台或跨托管平台的独立主页（应正常展示）**：如 `desktop/desktop` 的官方应用页 `https://github.com/apps/desktop`、GitHub 镜像仓 `OpenMW/openmw` 的上游主页 `https://gitlab.com/OpenMW/openmw`、`KiCad/kicad-source-mirror` 的 `https://gitlab.com/kicad/code/kicad`、GitHub Pages（`https://*.github.io/...`）及纯 `http://` 官网（如 `http://gitup.co`）。

### 1.2 后端详情拉取与目录投影对 `homepage` 的清洗、自链回退与外链协议大小写存在缺口
1. **`detail_fetch.rs::resolve_detail_stats` 无差别补前缀与大小写敏感缺陷**：
   - 现行代码（`src-tauri/src/github/detail_fetch.rs:448-460`）仅用大小写敏感的 `starts_with("http://") || starts_with("https://")` 判断协议，并对其他一切非空文本强行拼接 `format!("https://{}", trimmed)`：
     - 大写协议 `"HTTPS://zed.dev"` 会被拼成非法地址 `"https://HTTPS://zed.dev"`；
     - 仓库维护者在 GitHub Website 栏填写的占位词（`"None"`、`"N/A"`、`"TBD"`）或非网页协议（`"javascript:..."`、`"ftp://..."`、`"mailto:..."`）会被污染成 `"https://None"`、`"https://javascript:..."`，同时阻断 `.or_else(|| catalog_item.homepage)` 向精选收录库兜底！
2. **远端仓库自链冲掉精选收录库 / 本地库独立主页**：
   - 在 `detail_fetch.rs::resolve_detail_stats` 与多源详情 `catalog_detail.rs::fetch_detail_from_forge` 中，若远端 API 返回的 `homepage` 恰好填了当前代码仓库自身 URL，而 `CatalogItem.homepage`（来自精选收录库或本地库精校）配置了真实的独立官网，直接优先取 `repo_info.homepage` 会把精校官网覆盖为仓库自链（导致弹窗首帧显示「官方主页」、详情返回后突然消失，并经 `merge_from_detail` 污染 `catalog_apps`）。
3. **缓存详情投影 `CatalogItem::overlay_detail_core` 未回填缺失主页**：
   - `src-tauri/src/github/models.rs:142-161` 在 `DetailRepository::project_detail` 命中 TTL 缓存时覆写名称、简介、图标、分类与收录时间，但当 `app_details.homepage` 为空（或为当前仓库自链）而精选收录库 / 本地库 `CatalogItem` 已补充独立 `homepage` 时未予回填。
4. **统一外链后端命令 `system.rs::open_external_url` 协议大小写不一致**：
   - 前端 `src/services/api/settings.ts::openUrl`（及 `settings.openUrl.test.ts:27-35`）允许大小写不敏感的 `/^https?:\/\//i` 直调 `open_url`，但后端 `src-tauri/src/commands/system.rs:33` 使用大小写敏感的 `starts_with("http://") / starts_with("https://")`，遇到 `HTTPS://...` 会直接报错拒绝。

### 1.3 前端 `useDetailCacheSync` 静默重验与富卡首帧未同步 `homepage`
- `src/app/hooks/useDetailCacheSync.ts:206-216` 在 `isBackgroundSilent = true`（内存快照 0ms 秒开后的后台 ETag 条件探查）更新 `selectedApp` 时，比较了 `latest_version`、`releases.length`、`stars` 与占位简介，但遗漏了 `(prev.homepage ?? null) !== (detail.homepage ?? null)`，导致后台重验感知到主页变更时弹窗不更新（尽管同文件 `patchSummary` 第 283 行已比对 `homepage`）。
- `handleOpenDetail` 内存命中分支未用 `catalogHit.homepage` 治愈空 `cachedForShow.homepage`，内存未命中分支也未从 `snapshotTrendEnrichCache()` 提取已富化的 `homepage` 作为 `initialDetail` 首帧值。

### 1.4 顶部信息栏 `.modal-app-repo` 遗留非单色内联紫色样式
- `src/components/AppDetailModal/Header.tsx:402-459` 中，开发者按钮与「问题反馈」外链仍残留早期内联 `color: 'var(--brand-primary)'`（紫色 `#5E6AD2`），且仓库外链缺少 `:hover` / `:focus-visible` 交互态，与 `CONTEXT.md` **D4 Linear 去彩单色界面**规范不一致。新增「官方主页」入口时需在 `src/styles/components-modal.css` 抽离统一的单色元数据外链样式类 `.modal-meta-link`，消除顶栏色彩割裂。

---

## 2. 目标架构与交互设计

### 2.1 架构契约一致性检查
- **零新增 IPC 命令**：完整复用既有统一外链通道——`Header.tsx::handleOpenExternal` → `tauriApi.openUrl`（`src/services/api/settings.ts`，Tauri 原生 `CMD.openUrl` 优先、非 Tauri / 异常经 `resolveFallbackOpener()` 原生兜底；视图与组件严禁直调 `invoke` 或裸调被 `browserLockdown` 劫持的 `window.open`）。
- **零 Schema 变更**：所有持久化表（`catalog_apps`、`custom_apps`、`app_details`、`repo_card_cache`）已具备 `homepage` 列，无需推进 SQLite `user_version`。
- **零 ADR 冲突**：严格遵循 ADR-0001、ADR-0006、ADR-0010 与 `CONTEXT.md` D1–D10。

### 2.2 合法 `http(s)` 校验与当前代码仓库地址判重规则（SSOT）

在前端 `src/utils/appHelper.ts` 提供纯函数 `buildAppRepoUrl` 与 `resolveExternalHomepageUrl(homepage, repoUrl)`（后端 `normalize_http_homepage` 与 `is_same_repo_homepage` 对齐同构语义）：

1. **当前代码仓库基准地址构造 `buildAppRepoUrl(app)`**：
   - 取 `host = (app.forge_host ?? '').trim()`，剥除可能误带的前导 `http(s)://` 与尾部 `/`，为空时回退 `'github.com'`；
   - `owner` 或 `repo` trim 后为空返回 `''`，否则返回 `https://${host}/${owner}/${repo}`。
   - `Header.tsx` 的仓库链接、`issues/new` 反馈链接与主页判重统一消费同一 `repoUrl`。

2. **有效 `http(s)` 链接判定**：
   - 仅接受非空字符串；`trim()` 后不含任何内部空白字符（`!/\s/.test(trimmed)`）；
   - 必须通过无 base 的标准 `new URL(trimmed)` 解析（自动拒绝无协议裸域名、相对路径 `/docs` 与语法损坏 URL）；
   - `parsed.protocol` 必须严格为 `'http:'` 或 `'https:'`（兼容大写 `HTTP://` / `HTTPS://`，拒绝 `javascript:`、`data:`、`vbscript:`、`mailto:`、`ftp:`、`file:`、`zstore:` 等一切非网页协议）；
   - 拒绝携带内嵌凭据的钓鱼形态 URL（`parsed.username === '' && parsed.password === ''`）；
   - `parsed.hostname` 剥除尾点后非空、不以 `.` 开头，且为合法网络主机（含 `.` 的域名/IPv4、`localhost` 或 `[...]` IPv6）。

3. **与当前代码仓库地址的等价判重（命中即隐藏，返回 `null`）**：
   - 对 `homepage` 与 `repoUrl` 分别提取规范化主机与仓库路径：
     - **主机归一 `comparableHost(u)`**：`u.hostname` 小写化、去尾点 `.`、剥除单一前导 `www.`（使 `www.github.com` 等价于 `github.com`），若存在非默认端口 `u.port`（`URL` 标准已自动抹平 `http:80` 与 `https:443`，同时保留自建实例 `:8443`）则拼接 `:${u.port}`；
     - **路径归一 `comparableRepoPath(u.pathname)`**：安全 `decodeURIComponent`、折叠连续 `/`、剥除末尾 `/`、大小写不敏感剥除末尾 `.git` 后缀，整体转小写（如 `/BurntSushi/ripgrep.git/` → `/burntsushi/ripgrep`）。
   - 当 `comparableHost(homepage) === comparableHost(repoUrl)` **且** `comparableRepoPath(homepage) === comparableRepoPath(repoUrl)` 时，无论协议是 `http` 还是 `https`、是否附带 `#readme` 锚点或 `?tab=readme-ov-file` 等仓库页查询参数，一律判定为指向当前代码仓库自身，返回 `null` 不展示。
   - 同主机的不同路径（如 `https://github.com/apps/desktop`、`https://github.com/owner/repo/wiki`）或不同主机（如 `https://gitlab.com/OpenMW/openmw`、`https://owner.github.io/repo`）均不等价，正常返回归一协议小写后的完整 URL（保留原始路径、尾斜杠、查询串与锚点，不做截断）。

### 2.3 顶部信息区布局、国际化文案与 D4 单色视觉规范

1. **挂载位置（`src/components/AppDetailModal/Header.tsx`）**：
   - 位于弹窗顶部信息容器 `.modal-header-info` 的次级元数据外链条 `.modal-app-repo` 内，置于 `最新发布 {{version}}` 与 `问题反馈` 之间（仅当 `homepageUrl` 非 `null` 时连同前导分隔符 `·` 一并渲染）：
     ```text
     [👤 owner] / [repo ↗] · 最新发布 1.2.0 · [🌐 官方主页 ↗] · [🐞 问题反馈] [🔄]
     ```
2. **交互与无障碍契约**：
   - 元素为 `<a href={homepageUrl} target="_blank" rel="noopener noreferrer" className="modal-meta-link modal-homepage-link" data-testid="detail-homepage-link" title={t('detail.homepage_open_title', { url: homepageUrl })} onClick={(e) => handleOpenExternal(e, homepageUrl)}>`；
   - 内部图标采用 `lucide-react` 线性单色矢量图标 `<Globe size={12} strokeWidth={1.5} aria-hidden="true" />` + `<span>{t('detail.homepage_link')}</span>` + `<ExternalLink size={11} strokeWidth={1.5} aria-hidden="true" />`；
   - 悬停 `title` 完整展示未经截断的目标网址 `homepageUrl`；
   - 点击统一调用 `handleOpenExternal(e, homepageUrl)`（执行 `e.preventDefault()` + `e.stopPropagation()` + `void tauriApi.openUrl(homepageUrl).catch(() => {})`），不触发遮罩关闭，不走被锁定的 `window.open`。
3. **中英文国际化文案（`src/locales/zh-CN.json` & `src/locales/en-US.json`）**：
   | Locale Key | `zh-CN` | `en-US` |
   |---|---|---|
   | `detail.homepage_link` | `"官方主页"` | `"Homepage"` |
   | `detail.homepage_open_title` | `"访问官方主页: {{url}}"` | `"Open official homepage: {{url}}"` |
4. **D4 Linear 去彩单色视觉适配（`src/styles/components-modal.css`）**：
   - 新增 `.modal-meta-link` 单色内联外链样式：
     - 常态：`color: var(--text-secondary)`、`font-weight: 510`、`border: 1px solid transparent`、`border-radius: var(--radius-xs)`、`padding: 1px 5px`、紧凑 `inline-flex` 居中对齐，图标继承 `currentColor`；
     - 悬停（`:hover`）：`color: var(--text-primary)`、`background: var(--bg-acrylic-hover)`、`border-color: var(--border-subtle)`，深浅双模（Light `#FFFFFF` / Dark `#0F1011`）自动经语义 Token 适配；
     - 按压（`:active`）：`transform: scale(0.97)`（遵循 `0.12s var(--ease-smooth)`，并在 `prefers-reduced-motion: reduce` 下关闭过渡）；
     - 键盘聚焦（`:focus-visible`）：`outline: 2px solid var(--border-highlight); outline-offset: 1px;`；
   - 同步将同排 `.modal-app-repo` 内的仓库外链、「问题反馈」外链收敛至 `.modal-meta-link`，并移除开发者按钮与反馈链接残留的内联 `color: 'var(--brand-primary)'`，彻底对齐 D4 去彩单色规范。

---

## 3. 实施 Issue 拆分与依赖拓扑

```text
Issue 01 (Rust 后端清洗、自链回退与 open_url 协议对齐) ──┐
                                                         ├──► Issue 03 (Header 官方主页入口、i18n、单色样式与全套回归测试)
Issue 02 (前端 URL 判重纯函数与 useDetailCacheSync 同步) ─┘
```

- [`01-backend-homepage-normalization-and-external-url-parity.md`](./issues/01-backend-homepage-normalization-and-external-url-parity.md)：后端 `homepage` 协议清洗、仓库自链不冲精校官网、`overlay_detail_core` 回填与 `open_external_url` 大小写协议对齐及 Rust 单测（`Status: resolved`）。
- [`02-frontend-url-guard-and-detail-cache-sync.md`](./issues/02-frontend-url-guard-and-detail-cache-sync.md)：前端 `buildAppRepoUrl` / `resolveExternalHomepageUrl` 纯函数与 `useDetailCacheSync` 首帧/后台静默刷新 `homepage` 同步及单测（`Status: resolved`）。
- [`03-detail-modal-header-homepage-ui-i18n-and-monochrome-tests.md`](./issues/03-detail-modal-header-homepage-ui-i18n-and-monochrome-tests.md)：`AppDetailModal/Header` 官方主页外链入口、中英文 i18n、`.modal-meta-link` 单色视觉适配及组件/国际化/样式全量回归测试（`Status: resolved`）。
