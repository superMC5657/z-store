# ADR-0008: 出站代理与 OAuth 加固及设置页重组与开发配置隔离

- **状态**: Accepted
- **日期**: 2026-09-07
- **决策者**: 架构与产品团队

## 上下文

- `github.com` 直连不通时，登录与 API 轮询整体失败：
  - Device Flow 端点（`DEVICE_CODE_URL`、`ACCESS_TOKEN_URL`）均落在 `github.com` 下，国内阻断即无法发起登录与轮询。
- Client ID 曾硬编码在代码中，无法按环境与用户覆盖，打包与自建分发不灵活。
- 轮询结果曾把 `Expired` 与 `Denied` 混为泛化 `Error`，用户分不清是码过期还是主动拒绝，提示具误导性。
- 设置页分组臃肿，代理、令牌、登录态、清单源、缓存与备份挤在一起，查找成本高。
- 生产 CSP 直接用于开发时，会拦截 Vite HMR（`http://localhost:1420` 与 `ws://localhost:1421`），开发热更新被拦。

## 决策

1. **网络代理（系统代理自动继承与本地截获）**：
   - **架构演进说明**：由于 Tauri 桌面客户端发出的 HTTP 请求天然受系统代理及本地代理软件（Clash / v2ray / TUN 模式）透明捕获，原本在应用内手动配置与测试 `127.0.0.1:7890` 出站代理（`http_proxy_url`、`set_forward_proxy`、`test_forward_proxy`）的功能已废弃并移除。
   - **保留系统代理静默预热**：
     - `normalize_windows_proxy_server` 解析注册表多协议形态，`https` 命中即取用并跳出，其次取 `http`、其他协议、裸地址。
     - 启动时经 `init_windows_system_proxy` 预热（依赖 `winreg 0.56.0`），确保 reqwest 自动对齐 Windows 注册表配置的系统代理。
     - 纯系统级透明接管，无需用户在应用内繁琐维护本地代理地址。

2. **网络代理与下载加速代理辨析（正交解耦）**：
   - 系统网络代理：由 OS / 代理软件接管，全透明转发 API 与登录请求。
   - 下载加速代理（`active_mirror`、`custom_proxy`，`mirror.rs` 的 `MirrorManager`）：只管 GitHub Release 二进制大文件下载 URL 前缀重写（如 `https://gh-proxy.com`）。
     - `direct` 为官方直连，`https://gh-proxy.com` 为常用加速前缀。
     - 测速徽标阈值为 `400ms` 与 `1000ms`：低于 `400ms` 为绿，高于 `400ms` 为黄，高于 `1000ms` 为橙，失败为红。
   - 一句话区分：API与登录走系统代理透明截获；大文件下载慢在设置页切换下载加速代理。

3. **OAuth 加固（Device Flow）**：
   - Client ID 三级优先级公式为设置覆盖优先：
     - `github_oauth_client_id`（`SETTING_OAUTH_CLIENT_ID`）大于编译期 `ZSTORE_GITHUB_OAUTH_CLIENT_ID` 大于内置默认 `Ov23lik0b7fDGMLTiOYH`。
     - 实现为 `resolve_oauth_client_id`（`oauth.rs:39-44`）与 `resolve_oauth_client_id_from_db`（`commands.rs:2628`）。
   - 占位拦截文案固定：
     - 占位值为 `YOUR_CLIENT_ID_HERE`（`OAUTH_CLIENT_ID_PLACEHOLDER`，`oauth.rs:16`）。
     - `oauth_device_start`（`commands.rs:2650`）命中占位直接返回 `尚未配置 GitHub OAuth Client ID，请在「设置」中填写后重试`。
   - 五态表由 `DevicePollOutcome` 承载（`oauth.rs:80-91`），解析为 `classify_device_poll`（`oauth.rs:104-145`）：
     - `Pending`：对应 `authorization_pending` 与 `slow_down`。
     - `Authorized`：携带 `access_token`，空令牌不算授权。
     - `Expired`：对应 `expired_token`，文案为 `设备验证码已过期，请重新开始授权`。
     - `Denied`：对应 `access_denied`，文案为 `用户拒绝了授权请求`。
     - `Error`：未知错误透出 `error_description`，非 JSON 体提示轮询响应无法解析。
     - 前端 `api.ts:1009-1025` 把 `authorized` 收敛为 `complete`，其余保留 `pending`、`expired`、`denied`、`error`。
   - 协议常量固定：
     - 端点为 `https://github.com/login/device/code`（`DEVICE_CODE_URL`）与 `https://github.com/login/oauth/access_token`（`ACCESS_TOKEN_URL`）。
     - 权限为 `OAUTH_SCOPE = public_repo`（`oauth.rs:32`），为仍能 Star 的最小权限。
     - 发起与轮询超时均为 `10s`（`oauth.rs:259/289`）。
   - 前端容错为连续 `10` 次失败才停：
     - `OAuthAccountCard` 以 `pollFailRef` 计数，抖动只提示 `网络波动，自动重试中` 并继续下一轮。
     - 攒够 `10` 次才停轮询，且保留用户码展示，提示检查网络后取消重来。
     - 轮询间隔下限为 `Math.max(1000, interval * 1000)`。
   - 成功即自动拉起浏览器兜底：
     - `handleLogin` 成功后调 `api.openUrl(verificationUri)`（`api.ts:1111` 的 `openUrl`）。
     - 拉起失败不阻塞，卡片保留手动前往授权页按钮。
   - CI 变量由打包机注入：
     - `release-tauri.yml:102-103` 注入 `ZSTORE_GITHUB_OAUTH_CLIENT_ID`，未配置回退内置默认。
     - 该值为公开标识，非密钥；访问令牌只存 `user_settings.github_oauth_token`（`SETTING_OAUTH_TOKEN`），永不打印日志。

4. **设置页重组为五组**：
   - 第一组为外观与显示：主题、界面缩放、全局字号。
   - 第二组为更新与提醒：自动检查频率、客户端更新行、关注提醒频率、版本锁定规则入口。
   - 第三组为 GitHub 账号与配额：`OAuthAccountCard` 登录卡片与 PAT 令牌管理，锚点为 `settings-account`。
   - 第四组为网络与清单数据：加速节点切换与测速、下载加速代理、收录清单同步、详情缓存 TTL。
   - 第五组为数据备份与恢复：软件资产清单 JSON 导出、`DataBackupRow`、恢复出厂设置。
   - 状态指示保留：右下速率胶囊与节点延迟徽标不变，设置内配额徽标与锚点跳转同步保留。
   - TTL 恰好六档（键为 `detail_cache_ttl_minutes`）：`0`、`10`、`30（默认推荐）`、`60`、`360`、`1440`。

5. **开发配置隔离**：
   - 新增 `src-tauri/tauri.dev.conf.json`，全 `8` 行，只放宽 `app.security.csp`。
   - 放行行为 `connect-src` 与 `default-src` 中的 `http://localhost:1420` 与 `ws://localhost:1421`，保障 HMR。
   - 合并语义为 Tauri 的 `--config` 文件合并，开发启动时叠加到主配置之上。
   - 启动命令为 `pnpm tauri:dev`（`package.json:11`），等价于 `tauri dev --config src-tauri/tauri.dev.conf.json`。
   - 该文件仅用于开发，禁止用于构建；`pnpm tauri build` 不带该参数，生产 CSP 保持收紧。

## 后果与收益

- **积极收益**：
   - 网络自适应：系统代理自动探测与 TUN 本地截获打通，无额外手动配置心智负担。
   - 登录可解释：五态分离后，过期、拒绝、网络抖动各有明确文案与下一步动作。
   - 设置可找到：五组分区降低滚动查找成本，TTL 六档与代理辨析一次讲清。
   - 开发可热更：开发 CSP 放行后不再拦截 HMR。
- **代价**：
   - Client ID 三级覆盖增加排查链路，出问题需先确认生效的是哪一级。
- **防护**：
  - 非法代理地址在入库前拦截，错误文案直接定位缺主机名、缺端口、不支持协议。
  - 占位值拦截阻止无效 Device Flow 发起，避免用户对着失效二维码等待。
  - 轮询 `10` 次熔断防止无限重试，用户码保留避免有效授权被误杀。
  - 开发配置与构建配置隔离，`tauri.dev.conf.json` 永不污染生产包。
