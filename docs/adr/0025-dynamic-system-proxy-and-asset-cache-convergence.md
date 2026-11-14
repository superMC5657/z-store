# ADR-0025：动态系统代理快照、镜像边界校准与前端远端资源缓存收敛

- 状态：Accepted
- 日期：2026-11-14
- 关联：ADR-0002（直连 API 与镜像管道；本 ADR 细化其 §1 的清单例外）、ADR-0004（流式安装与 SHA-256 校验）、ADR-0008（出站代理；本 ADR 修订其 §1、§2）、ADR-0011（doforce 趋势聚合源；本 ADR 修订其直连口径）、ADR-0012（出站网络 P0 连接池）、ADR-0015（统一图标获取）
- 落地计划：`.scratch/outbound-proxy-and-asset-convergence/`
- 实现：`src-tauri/src/proxy/`（`mod.rs`、`windows.rs`、`linux.rs`、`macos.rs`）、`src-tauri/src/forge/http.rs`、`src-tauri/src/mirror.rs`、`src-tauri/src/installer/downloader_http.rs`、`src-tauri/src/commands/network.rs`、`src-tauri/src/github/catalog_service.rs`、`src-tauri/src/github/asset_fetch.rs`、`src/services/assetCache.ts`、`src/components/AppIcon.tsx`、`src/components/CachedAvatar.tsx`

## 1. 背景

主要用户在中国大陆，`github.com`、`raw.githubusercontent.com`、`avatars.githubusercontent.com` 等域名直连常见重置、DNS 污染与高丢包，用户依赖系统代理（Clash / Mihomo / v2rayN 等）或下载加速镜像（`gh-proxy.com`）。需要同时满足：

- 运行中开启、关闭或切换系统代理无需重启客户端即可生效；
- 已开系统代理的用户在默认 `direct` 镜像档下载上游资产时走系统代理，而不是被强制裸连；
- 未开系统代理的用户也能同步官方精选收录清单；
- README、更新日志插图、图标与头像经后端（系统代理 + 磁盘缓存）获取，WebView 不对同一图片重复直连；
- ADR-0008「应用内不设手动出站代理配置项」与 ADR-0004 / D3「`checksums.txt` 绝不经下载镜像」两条不变量保持不变。

## 2. 决策

### 2.1 动态系统代理快照 `ProxySnapshot`

- `ProxySnapshot { http, https, all, no_proxy_entries, source }` 描述某一时刻生效的系统代理，`source` 为 `ProxySource`（`Env` / `Windows` / `Gnome` / `MacOs` / `None`，日志短名 `env` / `win` / `gnome` / `macos` / `none`）；`signature(extra_hosts)` 为确定性签名（三类代理地址 + 合并后 `no_proxy`），只作连接池缓存键，不落日志。
- 求值顺序：`setup()` 最早期经 `capture_initial_env_proxy` 冻结一次终端显式传入的 `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`；其中有代理地址时恒用之，否则实时读取 OS 配置：
  - Windows：`HKCU\...\Internet Settings` 的 `ProxyEnable`、`ProxyServer`（多协议 https → http → 其他 → 裸地址）与 `ProxyOverride`（`<local>` → `localhost`/`127.0.0.1`/`::1`，`*.domain` → `.domain`，`NoProxy` 无法解析的 IP 通配跳过）；`ProxyEnable == 0` 即直连快照。
  - Linux：GNOME `gsettings org.gnome.system.proxy`，仅 `manual` 取 http/https/socks（`socks5h://`）与 `ignore-hosts`；`none` / `auto` 为直连快照（不支持的模式同一模式只告警一次）。
  - macOS：`scutil --proxy` 的 `HTTP*` / `HTTPS*` / `SOCKS*`（`socks5h://`）与 `ExceptionsList`。
- 生产代码不调用 `std::env::set_var` 写任何代理变量。
- `current_proxy_snapshot()` 带 5 秒采样冷却（`PROXY_CACHE_TTL_MS`），只持锁做内存读写、绝不在锁内探测：过期即返回旧快照并由后台线程重探（同一时刻至多一个），仅进程首次调用同步探测；签名变化时记 `network / proxy changed`（只含 host 摘要）。连接失败或超时（`is_connect() || is_timeout()`）时传输层调用 `invalidate_proxy_snapshot()`；GitHub ETag 重试循环经 `refresh_after_transport_error()`（`spawn_blocking` 立即重探）判断签名是否变化，变化即换用重建后的 API 池重试（该通道调用方均为带 Token 的 API 请求，详情拉取亦走 API 池）；GitLab / Gitea Provider 的 `get_with_retry_after_once` 同口径，签名变化时用重建后的 API 池重发一次。传输错误记账统一经 `proxy::note_transport_error`。
- `apply_proxy_snapshot` 恒先 `builder.no_proxy()` 关闭 reqwest 自身的系统代理读取：直连快照即纯直连；有代理时逐 scheme 挂载 `Proxy::http` / `Proxy::https`（缺省回退 `all`），附加合并 `NoProxy`（启动 env `NO_PROXY` + 快照绕过列表 + 默认豁免 `gh-proxy.com`/`localhost`/`127.0.0.1`/`::1` + 调用方 `extra_hosts`）。

### 2.2 连接池按签名热重建（D5 隔离不变）

- `proxy::ClientSlot` 以「代理签名 + 构建参数」为键缓存单个 `reqwest::Client`：键不变复用连接池，变化即原子重建，构建失败不污染槽位。
- API 池（`forge::http::new_api_client` / 不可失败版 `api_client`，`crate::shared_http_client` 同池，缺省 ZStore UA）、图标/CDN 池（`new_icon_client`，有限重定向，无 Token）、清单池（`CatalogService::http_client`，无 Token，pool 10）、趋势直连池（`trend_direct_client`，整体超时 5s，无 Token）各占一个槽位，池种类由 `PoolKind` 显式决定；`AppState` 不持有启动期 Client。构建失败时经 `proxy::fallback_client` 兜底，仍按快照挂代理，不回落 reqwest 自行读取 OS 代理。
- 安装包下载池 `DOWNLOAD_CLIENTS` 以含直连豁免 host 的代理签名为键，上限 8，超限整体清空。

### 2.3 镜像与系统代理正交：只豁免实际生效的镜像 host

- `MirrorManager::rewrite_installer_asset_url_resolved` 返回 `ResolvedDownloadUrl { url, bypass_proxy_host }`：仅 GitHub 资产经镜像前缀改写时 `bypass_proxy_host = Some(镜像 host)`；`direct` 档与非 GitHub 资产（Codeberg / GitLab / Gitea）为 `None`。`wrap_gh_proxy_resolved` 的公共兜底同理豁免 `gh-proxy.com`。
- `download_with_progress` 的 per-client `no_proxy` 只追加 `bypass_proxy_host`：官方直连下载完整继承系统代理，镜像流量直连镜像节点、不消耗代理流量。
- 设置页测速：测镜像节点时豁免该镜像 host；测「官方直连」时不豁免，测得的是当前系统网络（含系统代理）到达 `github.com` 的延迟。

### 2.4 趋势源 `trend.doforce.dpdns.org`：直连优先、系统代理回退

- 该 host 不在全局默认 `no_proxy` 中。`fetch_trends_text` 请求它时先用把它列入 per-client `no_proxy` 的直连 Client（整体超时 5s，含读 body）；超时、传输错误或 5xx 且当前快照 `has_proxy()` 时，经共享 API 池（走系统代理）重试一次（6s）。2xx 与 4xx（含 429）不重试。两跳都不携带任何认证头。经代理救活的抓取只记一行（成功 `fetch ok` 或失败告警，均带 `via=proxy`）。
- `github.com` / `api.github.com` 仍为单跳共享 API 池 10s。

### 2.5 官方默认清单镜像回退

- 仅当同步目标为官方默认源（`is_default_catalog_source`）且首跳（清单池，跟随系统代理，携带 `If-None-Match`）发生传输错误、429 或 5xx 时，经镜像前缀重试一次：用户自定义镜像（`active_mirror_prefix`）优先，否则 `https://gh-proxy.com`。镜像 host 走 per-client `no_proxy`，绝不携带 Token；镜像请求不发 `If-None-Match`（镜像回 304 视为失败，无法冻结目录），镜像 ETag 不落库；其余 4xx 不回退。
- 镜像响应必须解析为非空 `Vec<CatalogItem>` 且每条 `id` 经 `canonical_app_id` 合法，否则整体拒绝、不写 `catalog_apps`。同步宽事件记 `via = direct | mirror | local`。
- 自定义 HTTP(S) 清单源与本地 `file://` 路径永不经镜像。
- 理由：官方清单是只读公开目录元数据，不含可执行载荷，也不决定安装包 SHA-256 真值；严格结构校验挡住门户页与截断响应。

### 2.6 校验清单保持直连/系统代理

- `extract_checksums_map` 恒请求资产原始 `browser_download_url`，绝不经镜像改写（防同源镜像同时伪造二进制与哈希）；硬超时 `CHECKSUM_FETCH_TIMEOUT = 6s`（不超过 API 超时），留足跨国代理 `github.com` → `objects.githubusercontent.com` 302 跳转的握手时间。

### 2.7 前端远端图片收敛

- `fetch_or_cache_asset_url` 命中 `cache/assets/` 有效文件、304 复验、离线旧文件兜底或新下载落盘后，返回经魔数校验的 `data:<mime>;base64,...`（落盘失败仍以内存字节返回）；非候选（动态徽章 shields/camo/badge/workflow、非白名单扩展名）、超过 5MB 或下载失败且无旧盘文件时返回原 URL。
- `src/services/assetCache.ts`：真实 Tauri 运行时（`__TAURI_INTERNALS__.invoke` 可用且非 `__ZSTORE_DEMO_MOCK__`）下维护有界内存缓存（120 条 + 约 48MB 字符总量，FIFO）与同 URL 单飞；`useResolvedMarkdownImages` 首屏同步直填已缓存图片，未命中的可缓存图片（含 ≤5MB 的 `.gif`）置 1×1 透明占位并把原址暂存于 `data-zstore-src`（`srcset` 暂存于 `data-zstore-srcset` 并摘除），再以并发 4 解析回填（200ms 节流批量刷新）。README（`useDetailReadme`）与已安装页 `ChangelogDrawer` 共用该 Hook。jsdom 单测与官网 Demo 原样直出。
- `<AppIcon>`：真实 Tauri 运行时下，远端 http(s) 图标未命中 `data:` 且后端 `get_or_fetch_icon` 不在失败退避期时，只渲染空底板、不挂远端 `<img>`，由后端单飞读盘/下载后经 `subscribeIconDataReady` 切入 `data:`；后端失败（含返回非 `data:`）即设退避并唤醒等待组件，回退 WebView 直连 `<img>`，再失败定格首字母徽章且不重复请求后端。
- `<CachedAvatar>`：侧栏账号胶囊、设置页账号卡与开发者主页弹窗的 GitHub 头像经 `resolveCachedAssetUri`（即 `fetch_or_cache_asset_url`，30 天落盘）渲染；等待、无头像或加载失败显示首字母圆形徽章。

## 3. 后果

- 正面：系统代理开关即时生效；`direct` 档下载与测速反映真实系统网络；无代理用户可同步官方清单；doforce 局部阻断可经代理救活；README/更新日志/图标/头像不再前后端双发，离线时命中落盘缓存。
- 代价：OS 代理读取每 5 秒至多一次，在后台线程执行（Linux 为若干 `gsettings` 子进程、macOS 为一次 `scutil`），过期后首个请求仍用旧快照；`data:` URI 增大 DOM 字符串体积（由内存缓存双上限约束）；真实 Tauri 下未缓存图片首屏为占位，等待后端返回。
- 防护：PAC / 自动代理脚本不解析（视为直连）；镜像回退仅限官方清单且严格校验；`checksums.txt`、API、README 正文、图标与自定义清单源恒不经镜像；签名串可能含代理凭证，仅作缓存键。
