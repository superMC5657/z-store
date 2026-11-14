# Feature Spec: 系统代理动态热感知、镜像边界校准与前端远端资源缓存收敛（Outbound Proxy & Asset Convergence）

> 状态：Implemented（Issues `resolved`，决策见 ADR-0025）
> 关联契约：`CONTEXT.md`（D2 零服务器成本与解耦清单同步、D3 零信任完整性防篡改、D5 双池复用、D7 有限重试、D9 趋势与首页、D10 统一图标获取）、ADR-0002（客户端直连 GitHub API 与加速镜像下载管道）、ADR-0004（流式安装器与 SHA-256 校验）、ADR-0008（出站代理与 OAuth 加固）、ADR-0009（独立生态清单仓库解耦）、ADR-0011（doforce 趋势聚合源例外）、ADR-0012（出站网络性能 P0）、ADR-0015（统一图标获取与搜索对齐）。

---

## 1. 背景与全链路诊断

面向中国大陆为主的用户群体，`github.com`、`api.github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com`、`avatars.githubusercontent.com` 等域名在直连环境下普遍存在连接重置、DNS 污染或跨国高丢包问题，用户高度依赖系统代理（Clash / Mihomo / v2rayN 等）或下载加速代理（`gh-proxy.com`）。

经对前后端全量网络出口逐行排查，定位出 **5 类核心痛点与代码级断层**：

### 1.1 后端 HTTP 客户端为启动期静态单例，运行中途开关/切换系统代理完全失效（P0）
- **现状（`src-tauri/src/lib.rs:129, 326, 477`、`src-tauri/src/proxy/mod.rs`、`src-tauri/src/forge/http.rs:69-70`、`src-tauri/src/github/catalog_service.rs:71`、`src-tauri/src/installer/downloader_http.rs:13`）**：
  - Windows（`init_windows_system_proxy`）与 Linux（`init_linux_system_proxy`）仅在 `setup()` 启动阶段读取一次系统代理并调用 `std::env::set_var` 写入进程环境变量；macOS 分支直接返回 `"none"`（未读取系统代理，导致终端无环境变量时 `apply_proxy` 无法注入 `NoProxy`，使 macOS 下 `gh-proxy.com` 镜像流量误走系统代理消耗梯子流量）；Windows 亦未读取注册表 `ProxyOverride` 绕过列表。
  - 后端所有连接池（`SHARED_HTTP_CLIENT`、`SHARED_API`、`SHARED_ICON`、`CatalogService.client`、`DOWNLOAD_CLIENTS`）均为 `OnceLock` 长生命周期单例，首次 `build()` 时即将代理规则焊死。
  - **受损场景**：国内用户「先打开 ZStore 发现刷不出内容，再去开启 Clash 系统代理」时，前端 WebView2 即时生效，但后端全部 API、搜索、详情、清单同步仍死走直连，必须重启客户端；反之启动时开了代理、中途关闭代理软件后，后端仍死连本地代理端口报 `Connection refused`。

### 1.2 默认 `direct` 模式下，安装包下载器与直连测速误将原始域名塞入 `no_proxy` 强行绕过系统代理（P0 Bug）
- **现状（`src-tauri/src/installer/downloader_http.rs:64` & `src-tauri/src/mirror.rs:218`）**：
  - `download_with_progress` 无条件执行 `let dl_extra = crate::proxy::proxy_hosts_for(download_url);` 并拼入该下载 Client 的 `NoProxy`。
  - 当 `active_mirror` 处于默认的 `"direct"`（官方直连）状态时，`download_url` 为原始的 `https://github.com/...` 或 `https://codeberg.org/...`，导致 **`github.com` / `codeberg.org` 本体被加入 `no_proxy`**，强行绕过用户已开启的系统代理裸连！
  - 后果：已开启系统代理的用户安装 GitHub 应用时，第一跳必裸连超时/失败，白白等待后才触发 `installer_download.rs:56` 的 `gh-proxy.com` 兜底；而下载 Codeberg / GitLab / Gitea 资产因无镜像兜底会直接失败。同理，`test_proxy_latency(None)` 测试官方直连时也将 `github.com` 塞入 `no_proxy`，无法反映系统代理下的真实连通性。

### 1.3 官方精选收录清单同步与趋势聚合源在受限网络下缺乏弹性回退（P1）
- **现状**：
  1. **清单同步（`src-tauri/src/github/catalog_service.rs:413`）**：默认源 `https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json` 失败即报错，未开启系统代理的国内用户无法获知任何新收录应用，永久停留在安装包内置的静态种子清单（`Catalog Seed Fallback`）。
  2. **校验清单超时偏紧（`src-tauri/src/github/detail_fetch.rs:870`）**：`extract_checksums_map` 拉取 `checksums.txt` 需要经历 `github.com` → `objects.githubusercontent.com` 的跨国 302 重定向，3 秒硬超时在高延迟代理节点下易误判超时置空 `sha256`，触发安装时的 D3 未校验风险弹窗。
  3. **趋势聚合源硬编码直连（`src-tauri/src/proxy/mod.rs:31`）**：`trend.doforce.dpdns.org` 被写入全局静态 `default_no_proxy_entries()`。当其 Cloudflare 节点在国内局部运营商网络受阻时，即使用户已开启系统代理，后端仍被强制绕过代理直连导致 `rising` / `healthy` 两榜失败。

### 1.4 通用图片磁盘缓存返回值协议断层，README 与 Changelog 插图落回前端直连且产生双倍请求（P0 Bug）
- **现状（`src-tauri/src/github/asset_fetch.rs:337` & `src/components/AppDetailModal/useDetailReadme.ts:224-258` & `src/views/InstalledView/ChangelogDrawer.tsx`）**：
  - 后端 `fetch_or_cache_asset_url` 经 `new_icon_client`（带系统代理）将静态图片下载至 `cache/assets/` 后，返回的是**操作系统裸文件路径**（如 `C:\Users\...\xxxx.png`）。
  - 前端未做协议转换，而 `useDetailReadme.ts:247-253` 校验返回值必须以 `asset:` / `tauri:` / `asset.localhost` 开头，判定恒为 `false` 并直接丢弃。
  - 同时，`useDetailReadme.ts:225` 首屏先将含远端 `https://` 的 HTML 写入 DOM（触发 WebView 抢跑直连请求），随后后端又下载一遍落盘闲置，形成**前后端双倍流量消耗**；`.gif` 动图与 `ChangelogDrawer` 中的更新日志图片亦完全裸连前端。

### 1.5 Tauri 下 `<AppIcon>` 未命中内存时前后端双发竞速，且 GitHub 头像完全前端裸连无缓存（P1）
- **现状（`src/components/AppIcon.tsx:145-152, 223` & `Sidebar.tsx:315` / `OAuthAccountCard.tsx:200` / `DeveloperProfileModal.tsx:132`）**：
  - 在真实 Tauri 桌面环境下，当图标为远端 `http(s)` URL 且前端内存 `iconDataCache` 尚未命中时，`<AppIcon>` 一边直接渲染 `<img src="https://...">`（WebView 发起第 1 次请求），一边在 `useEffect` 调用 `requestIconLocalCache -> get_or_fetch_icon`（后端 Rust 发起第 2 次请求转 `data:`）。无代理时前后端同时卡超时并经历「裂图 → 徽章 → 自愈」闪烁。
  - 登录账号胶囊、设置页账号卡与开发者主页弹窗的 `avatars.githubusercontent.com` 头像全部直接使用前端 `<img>` 裸连，无本地落盘缓存，国内无代理或离线启动时直接裂图。

---

## 2. ADR 契约冲突与显式修订声明

按 `docs/agents/domain.md` 规范，本方案保持 **ADR-0008「应用内不设手动出站代理配置项，纯系统级透明接管」** 与 **ADR-0004 / D3「`checksums.txt` 严守直连/系统代理、绝不经下载镜像代理，防止同源镜像同时伪造二进制与哈希」** 两大核心不变量不变，并对以下既有 ADR 条款作显式重开与细化（落地后记入 ADR-0025 并回写交叉引用）：

- > _Contradicts ADR-0002 §1（「checksum 清单、README 正文、图标、趋势与目录清单一律直连，失败即直连失败，不绕行下载镜像代理重试」），but worth reopening for `catalog.json` only because_：官方默认精选收录库清单（`z-store-catalog/main/catalog.json`）属于只读公开目录元数据，不含可执行载荷亦不决定安装包 SHA-256 校验真值；中国大陆未配置系统代理的用户因 `raw.githubusercontent.com` 阻断将永久无法同步新收录应用。**修订为**：仅当同步目标为官方默认清单源（`is_default_catalog_source`）且直连/系统代理请求发生传输失败或 5xx 时，允许回退经下载加速镜像前缀（当前有效自定义镜像或默认 `gh-proxy.com`，镜像 host 走 per-client `no_proxy` 且绝不携带 Token）重试并执行严格 JSON 结构与 `Canonical App Id` 校验；`checksums.txt`、API、README、图标与自定义清单源仍严禁绕行下载镜像。
- > _Contradicts ADR-0008 §2 & ADR-0011（「`trend.doforce.dpdns.org` 经 per-client `no_proxy` 始终直连」），but worth reopening because_：国内部分运营商网络对 Cloudflare / `dpdns.org` 存在间歇性阻断，硬编码全局 `no_proxy` 会导致已开启系统代理的用户也无法救活 `rising` / `healthy` 榜。**修订为**：`trend.doforce.dpdns.org` 从全局静态 `default_no_proxy_entries` 移出，在 `fetch_trends_text` 中改为「**直连优先（短超时免耗代理流量），传输失败/超时/5xx 且系统存在活跃代理时自动回退系统代理重试一次**」，兼顾零代理流量损耗与极端网络可用性，且仍严守不携带任何认证凭据的信任边界。

---

## 3. 目标架构设计

### 3.1 动态系统代理快照与多池按签名热重建（`src-tauri/src/proxy/` & HTTP Pools）
1. **无全局副作用的跨平台实时代理探测（`ProxySnapshot`）**：
   - 废弃向进程全局调用 `std::env::set_var("http_proxy" / "https_proxy")` 的一次性写入做法（消除多线程 `set_var` 风险及首次写入后锁死 `env::var` 导致后续无法感知关闭/切换系统代理的缺陷）；
   - 在 `setup()` 最早期一次性只读捕获外部终端显式传入的启动环境变量 `INITIAL_ENV_PROXY`；
   - 运行期 `probe_system_proxy() -> ProxySnapshot` 按「`INITIAL_ENV_PROXY`（若非空）→ OS 实时系统代理配置」求值：
     - **Windows（`proxy/windows.rs`）**：实时读取注册表 `Internet Settings` 的 `ProxyEnable`、`ProxyServer`（多协议优先 `https`）与 **`ProxyOverride`**（解析 `;` 分隔绕过项，将 `<local>` 映射为本地回环，`*.domain` 归一为 `.domain`）；`ProxyEnable == 0` 即返回直连快照。
     - **Linux（`proxy/linux.rs`）**：实时读取 GNOME `gsettings org.gnome.system.proxy`（仅 `manual` 模式提取 `http`/`https`/`socks` 与 `ignore-hosts`；切回 `none` 即返回直连快照）。
     - **macOS（`proxy/macos.rs`）**：通过 `scutil --proxy` 解析 `HTTPEnable`/`HTTPProxy`/`HTTPPort`、`HTTPSEnable`/`HTTPSProxy`/`HTTPSPort`、`SOCKSEnable`/`SOCKSProxy`/`SOCKSPort`（`socks5h://`）及 `ExceptionsList`，补齐 macOS 下的 `NoProxy` 合并能力。
2. **有界采样缓存与失败即时重探**：
   - `current_proxy_snapshot()` 内置 **5 秒采样冷却（`PROXY_CACHE_TTL_MS = 5_000`）**，常规高频并发请求直接命中内存快照（零注册表/子进程开销）；
   - 提供 `invalidate_proxy_snapshot()`：当 `github::http`、`forge::http` 等传输层捕获连接失败或超时（`is_connect() || is_timeout()`）进入重试退避前，主动失效快照缓存，使紧随其后的重试立即感知用户刚开启或刚关闭的系统代理。
3. **四类隔离连接池按签名热替换（严守 D5 物理隔离）**：
   - `ProxySnapshot::signature()` 生成确定性摘要串（含 `http`、`https`、`all` 与合并后的 `no_proxy`）；
   - API 池（统一 `shared_http_client()` 与 `forge::http::new_api_client()`，消除双 API 池冗余；移除 `AppState.http` 静态死字段或改为委托动态 `shared_http_client()`）、图标 CDN 池（`forge::http::new_icon_client()`，无 Token）、清单池（`CatalogService::http_client()`，无 Token）、安装包下载池（`DOWNLOAD_CLIENTS`，以 `"{proxy_sig}|{extra_no_proxy}"` 为键，上限 8）在代理签名未变时 100% 复用现有连接池，签名变化时自动原子重建新 `reqwest::Client`。
   - 当 `ProxySnapshot` 为直连时，`apply_proxy_snapshot` 显式调用 `builder.no_proxy()` 关闭 `reqwest` 内部静态系统代理兜底，确保关闭系统代理后立即切回纯直连。

### 3.2 安装包直连 `no_proxy` 修复与趋势 `doforce` 智能回退
1. **修正下载器与测速的 `no_proxy` 语义**：
   - `MirrorManager` 明确区分「未改写（官方直连）」与「已改写（镜像加速）」：新增 `MirrorManager::rewrite_installer_asset_url_detailed(&self, raw_url: &str) -> RewrittenAssetUrl { url: String, mirror_host: Option<String> }`（或等价纯函数）；
   - `download_with_progress` 仅将**实际生效的镜像节点域名**（`mirror_host`，如 `gh-proxy.com` 或用户自定义镜像域名）传给 `extra_hosts`（直连豁免）；当走官方直连（`mirror_host == None`）时，`dl_extra` 为空，完整继承系统代理下载 GitHub / Codeberg / GitLab / Gitea 资产；
   - `MirrorManager::test_proxy_latency(None)`（测试「GitHub 官方直连」通道）传空 `extra_hosts`，真实测量当前系统网络（含系统代理）到达 `github.com` 的延迟；测试具体镜像地址时仍将该镜像 host 加入 `extra_hosts` 测量镜像直连延迟。
2. **`fetch_trends_text` 对 `trend.doforce.dpdns.org` 双阶段策略**：
   - 移除 `default_no_proxy_entries()` 中的 `TREND_HOST`；
   - `fetch_trends_text` 请求 `trend.doforce.dpdns.org` 时，先以挂载 `extra_hosts = ["trend.doforce.dpdns.org"]` 的直连 Client 请求（单次超时 `5s`）；若遇超时、连接错误或 5xx 且当前 `current_proxy_snapshot().has_proxy()` 为真，自动回退使用带系统代理的 Client 重试一次（`6s` 超时），总预算受控且全程不携带任何 Token。

### 3.3 官方默认清单同步镜像回退与 `Checksum Manifest` 超时校准
1. **官方默认 `catalog.json` 失败镜像回退**：
   - 在 `CatalogService::fetch_remote_catalog`（或 `commands/catalog_sync.rs` 编排层）传入可选的镜像回退前缀（仅当 `is_default_catalog_source(url)` 为真时启用：若 `MirrorManager` 配置了合法自定义镜像则取自定义前缀，否则取 `DEFAULT_GH_PROXY` `https://gh-proxy.com`）；
   - 首跳始终通过 `CatalogService` 清单 Client（跟随系统代理）请求官方 `url`（携带 `If-None-Match`）；
   - 仅当首跳发生网络连接/超时错误或返回 `5xx` / `429` 时，构造镜像 URL `prefix_with_base(mirror, url)`，使用将该镜像 host 加入 `no_proxy` 的无 Token 清单 Client 重试一次；
   - 校验镜像返回的 JSON 解析结果非空且所有条目 `id` 经 `canonical_app_id` 校验合法后才予以采纳。
2. **`Checksum Manifest` 拉取超时校准**：
   - `detail_fetch.rs::extract_checksums_map` 继续严守直连/系统代理（**绝不走镜像**），将硬超时从 `3s` 提升至 `6s`（跟随后端动态系统代理 Client，留足跨国代理 302 跳转至 `objects.githubusercontent.com` 的握手时间）。

### 3.4 通用图片缓存 `data:` 协议桥接与 README / Changelog 收口
1. **后端 `fetch_or_cache_asset_url` 返回可直接渲染的 `data:` URI**：
   - 修改 `src-tauri/src/github/asset_fetch.rs`：当命中本地 `cache/assets/` 有效缓存文件或经 `new_icon_client`（带动态系统代理）新下载落盘成功时，读取已通过 `is_valid_image` 魔数校验的图片字节，调用共享 `crate::icons::bytes_to_data_uri(&bytes)` 返回 `data:<mime>;base64,...` URI（零 `assetProtocol` 文件系统暴露面，跨 Windows/macOS/Linux 100% 协议一致）；
   - 仅当 URL 不属于可缓存静态/动图候选（如 `shields.io` 动态徽章、超过 `MAX_ASSET_BYTES = 5MB` 的超大文件、或网络下载失败且无旧盘文件）时，回退返回原始 `https://` URL。
2. **前端消除首屏抢跑双请求并覆盖 `.gif` 与 `ChangelogDrawer`**：
   - 新增共享前端缓存模块（如 `src/services/assetCache.ts` + `useResolvedMarkdownHtml` Hook）：维护有界内存缓存（上限 120 条 FIFO，可将较大的 `data:` 转为 `blob:` ObjectURL 或缓存字符串以减小 DOM 体积，卸载/淘汰时安全释放）；
   - 在真实 Tauri 环境（非 `__ZSTORE_DEMO_MOCK__`）下解析 README 与 `ChangelogDrawer` HTML 时：
     - 已命中前端内存缓存的图片同步直填缓存 URI（0ms 无闪烁）；
     - 未命中的可缓存 `http(s)` 图片（**包含 `<= 5MB` 的 `.gif` 演示动图**，仅排除 `shields.io`/`badge` 等动态徽章），首屏先置透明占位（暂存原始地址于 `data-asset-src`，不挂远端 `src`，**彻底阻断 WebView 抢跑发起第 1 次直连请求**），随后以有界并发（`pool = 4`）调 `fetchOrCacheAssetUrl` 填入 `data:`（或回退原链）；
   - 非 Tauri 环境（Vitest `jsdom` 单测及官网 Demo 预览）保持同步原链直出，不阻塞已有测试断言。

### 3.5 `<AppIcon>` Tauri 单飞去双发与 GitHub 头像本地缓存
1. **`<AppIcon>` 在真实 Tauri 运行时收口后端单飞**：
   - 新增运行时辅助判定 `isRealTauriRuntime()`（`__TAURI_INTERNALS__.invoke` 为函数且 `!window.__ZSTORE_DEMO_MOCK__`）；
   - 在 `isRealTauriRuntime()` 为真时，若 `activeIcon` 为远端 `http(s)` URL、`iconOverride === undefined`、且前端 `iconDataCache` 尚未命中：
     - 若该 URL **未处于预热失败退避期**，`<AppIcon>` 暂缓挂载远端 `<img src="https://...">`（展示平滑底板/首字母占位），仅由 `requestIconLocalCache -> get_or_fetch_icon` 发起唯一一次后端读盘/下载，就绪后经 `subscribeIconDataReady` 立即切入 `data:` 实图（本地已落盘图标 ~1ms 完成，远端新图仅走后端系统代理下载 1 次，消除前后端双发）；
     - 若后端 `get_or_fetch_icon` 失败进入退避期（`startIconFetch` 的 `.catch` 同步触发 `notifyIconDataReady` 唤醒等待组件），组件回退尝试前端 `<img src={activeIcon}>`，若仍失败则定格首字母徽章。
   - 在 Vitest 单测（无 `__TAURI_INTERNALS__`）与官网 Demo（`__ZSTORE_DEMO_MOCK__ === true`）下保持原同步直出 `<img>` 行为，现有全部单测契约零破坏。
2. **GitHub 登录用户与开发者头像接入缓存（`<CachedAvatar>`）**：
   - 新建 `src/components/CachedAvatar.tsx`，内部复用 `fetchOrCacheAssetUrl`（`avatars.githubusercontent.com` 经后端系统代理下载并落盘 `cache/assets/` 30 天缓存 + 前端内存复用），加载失败或离线无缓存时优雅回退渲染首字母圆形徽章；
   - 接入 `src/components/Sidebar.tsx`、`src/components/OAuthAccountCard.tsx` 与 `src/components/DeveloperProfileModal.tsx` 三处头像渲染点。

---

## 4. IPC 与架构门禁合规说明

- **零新增/零破坏 IPC 命令名**：完全复用现有已注册命令 `fetch_or_cache_asset_url`、`get_or_fetch_icon`、`sync_catalog`、`test_proxy`、`fetch_trends_text` 等；`cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`（camelCase 请求键）、`noDirectInvoke.test.ts`（视图层禁直调 `api/client`）、`countDisplay.test.ts` 保持 100% 兼容。
- **Demo 预览兼容**：`src/demo/tauri-mock.ts` 中若有 `fetch_or_cache_asset_url` 调用，原样返回入参 `url`，且 `isRealTauriRuntime()` 识别 `__ZSTORE_DEMO_MOCK__` 不拦截浏览器端图片加载。

---

## 5. 实施 Issue 拆分与依赖拓扑

```text
  [01 动态系统代理快照与连接池热重建] ──► [02 直连下载/测速 no_proxy 修复与 doforce 代理回退] ──► [03 官方 catalog.json 同步镜像回退与 checksum 超时校准] ──┐
                                                                                                                                                            ├──► [06 ADR与领域文档同步及全量验收]
  [04 通用图片缓存 data: 协议桥接与 README/Changelog 收口] ──► [05 AppIcon 单飞去双发与 GitHub 头像落盘] ────────────────────────────────────────────────────┘
```

1. [`01-dynamic-system-proxy-and-client-hot-reload.md`](./issues/01-dynamic-system-proxy-and-client-hot-reload.md)（`ready-for-agent`，`Blocked by: none`）
2. [`02-fix-direct-download-no-proxy-and-doforce-fallback.md`](./issues/02-fix-direct-download-no-proxy-and-doforce-fallback.md)（`ready-for-agent`，`Blocked by: 01`）
3. [`03-catalog-sync-mirror-fallback.md`](./issues/03-catalog-sync-mirror-fallback.md)（`ready-for-agent`，`Blocked by: 01, 02`）
4. [`04-asset-cache-uri-bridge-for-readme-and-changelog.md`](./issues/04-asset-cache-uri-bridge-for-readme-and-changelog.md)（`ready-for-agent`，`Blocked by: none`，可与 01 并行）
5. [`05-app-icon-single-flight-and-avatar-cache.md`](./issues/05-app-icon-single-flight-and-avatar-cache.md)（`ready-for-agent`，`Blocked by: 04`）
6. [`06-docs-adr-and-regression-gates.md`](./issues/06-docs-adr-and-regression-gates.md)（`ready-for-agent`，`Blocked by: 01, 02, 03, 04, 05`）

---

## 6. 整体验收标准

- 客户端先在无代理状态下启动并触发失败请求后，开启系统代理（或从开启状态关闭系统代理），无需重启客户端，5 秒内（或连接失败自动重试时）API、详情、清单同步与图标拉取自动切换至最新代理状态；
- 开启系统代理且设置保持默认 `active_mirror = "direct"` 时，安装/仅下载 GitHub 或 Codeberg 应用的首跳请求不再将 `github.com` / `codeberg.org` 塞入 `no_proxy`，直接经系统代理成功下载；
- 未开启系统代理时，`sync_catalog` 对官方默认 `catalog.json` 首跳失败后可自动经 `gh-proxy.com`（或已配置的自定义镜像）完成同步；`checksums.txt` 保持绝不走镜像且超时放宽至 6s；
- `trend.doforce.dpdns.org` 默认直连不耗代理流量，直连失败且存在系统代理时自动经系统代理重试成功；
- 应用详情 README（含 `<= 5MB` `.gif`）与已安装页 `ChangelogDrawer` 中的可缓存图片经后端 `fetch_or_cache_asset_url` 落盘后以 `data:` 渲染，WebView 不再对同一静态图重复发起远端直连请求；
- 真实 Tauri 环境下 `<AppIcon>` 加载未缓存远端图标时不再产生「WebView `<img>` + 后端 `get_or_fetch_icon`」双请求；侧栏、设置账号卡与开发者弹窗头像支持本地落盘缓存与离线首字母回退；
- `cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`、`npx tsc --noEmit`、`npx vitest run` 全部零错误通过。
