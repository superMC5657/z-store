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
    - **架构说明**：无应用内出站代理配置项；API 与登录走系统代理透明截获，大文件下载走下载加速代理。
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
   - Client ID 二级优先级公式为设置覆盖优先：
     - `github_oauth_client_id`（`SETTING_OAUTH_CLIENT_ID`）大于 `config.toml [oauth].default_client_id`（当前为 `Ov23lik0b7fDGMLTiOYH`）。
     - 实现为 `resolve_oauth_client_id`（`oauth/constants.rs:28-33`）与 `resolve_oauth_client_id_from_db`（`commands/mod.rs:73-79`）；无编译期环境变量注入。
   - 占位拦截文案固定：
     - 占位值为 `YOUR_CLIENT_ID_HERE`（`OAUTH_CLIENT_ID_PLACEHOLDER`，`oauth/constants.rs:2`）。
     - `oauth_device_start`（`commands/oauth.rs:20-24`）命中占位直接返回 `尚未配置 GitHub OAuth Client ID，请在「设置」中填写后重试`。
   - 五态表由 `DevicePollOutcome` 承载（`oauth/types.rs:37-48`），解析为 `classify_device_poll`（`oauth/types.rs:61-102`）：
     - `Pending`：对应 `authorization_pending` 与 `slow_down`。
     - `Authorized`：携带 `access_token`，空令牌不算授权。
     - `Expired`：对应 `expired_token`，文案为 `设备验证码已过期，请重新开始授权`。
     - `Denied`：对应 `access_denied`，文案为 `用户拒绝了授权请求`。
     - `Error`：未知错误透出 `error_description`，非 JSON 体提示轮询响应无法解析。
     - 前端 `src/services/api.ts:384-395` 把 `authorized` 收敛为 `complete`，其余保留 `pending`、`expired`、`denied`、`error`。
   - 协议常量固定：
     - 端点为 `https://github.com/login/device/code`（`DEVICE_CODE_URL`）与 `https://github.com/login/oauth/access_token`（`ACCESS_TOKEN_URL`），定义于 `oauth/constants.rs:13-14`。
     - 权限为 `OAUTH_SCOPE = "public_repo user"`（`oauth/constants.rs:11`），覆盖 Star 与 Star 清单管理。
     - 发起与轮询复用共享 HTTP 客户端统一 API 超时（`config.toml api_timeout_seconds`，默认 `12s`；实现经 `shared_http_client`，见 `oauth/device_flow.rs`），无独立 `10s` 超时。
   - 前端容错为连续 `10` 次失败才停：
     - `OAuthAccountCard` 以 `pollFailRef` 计数，抖动只提示 `网络波动，自动重试中` 并继续下一轮。
     - 攒够 `10` 次才停轮询，且保留用户码展示，提示检查网络后取消重来。
     - 轮询间隔下限为 `Math.max(1000, interval * 1000)`。
   - 成功即自动拉起浏览器兜底：
     - `handleLogin` 成功后调 `api.openUrl(verificationUri)`（`OAuthAccountCard.tsx:119-124`，经 `src/services/api.ts:439-448` 的 `openUrl`）。
     - 拉起失败不阻塞，卡片保留手动前往授权页按钮。
   - Client ID 默认值来源：
     - 默认值收敛于 `config.toml [oauth].default_client_id` 单一配置源；`.github/workflows/release-tauri.yml` 不注入任何 OAuth Client ID 变量，不存在编译期环境变量覆盖。
     - 该值为公开标识，非密钥；访问令牌只存 `user_settings.github_oauth_token`（`SETTING_OAUTH_TOKEN`），永不打印日志。

4. **设置页重组为五组**：
   - 第一组为外观与显示：主题、界面缩放、全局字号。
   - 第二组为更新与提醒：自动检查频率、客户端更新行、关注提醒频率、版本锁定规则入口。
   - 第三组为 GitHub 账号与配额：`OAuthAccountCard` 登录卡片与 PAT 令牌管理，锚点为 `settings-account`。
   - 第四组为网络与清单数据：加速节点切换与测速、下载加速代理、收录清单同步。
   - 第五组为数据备份与恢复：软件资产清单 JSON 导出、`DataBackupRow`、恢复出厂设置。
   - 状态指示保留：右下速率胶囊与节点延迟徽标不变，设置内配额徽标与锚点跳转同步保留。
   - 详情缓存 TTL 由 `config.toml` 单一基线控制（默认 30 分钟），不在设置页暴露调节项（缓存策略详见 ADR-0007）。

5. **开发配置说明（以当前代码为准，无独立开发配置文件）**：
   - 无独立开发配置文件；开发与构建共用主配置 `src-tauri/tauri.conf.json`。
   - 开发地址收敛于主配置：`devUrl` 为 `http://localhost:1420`，`beforeDevCommand` 为 `pnpm dev`。
   - 启动命令为 `pnpm tauri dev`（经 `package.json:13` 的 `"tauri": "tauri"` 透传 Tauri CLI），无 `--config` 叠加文件。
   - 生产构建为 `pnpm tauri build`，沿用同一主配置的收紧 CSP。

## 后果与收益

- **积极收益**：
   - 网络自适应：系统代理自动探测与 TUN 本地截获打通，无额外手动配置心智负担。
   - 登录可解释：五态分离后，过期、拒绝、网络抖动各有明确文案与下一步动作。
   - 设置可找到：五组分区降低滚动查找成本，TTL 六档与代理辨析一次讲清。
    - 开发可热更：开发 CSP 放行 localhost HMR。
- **代价**：
   - Client ID 三级覆盖增加排查链路，出问题需先确认生效的是哪一级。
- **防护**：
  - 非法代理地址在入库前拦截，错误文案直接定位缺主机名、缺端口、不支持协议。
  - 占位值拦截阻止无效 Device Flow 发起，避免用户对着失效二维码等待。
  - 轮询 `10` 次熔断防止无限重试，用户码保留避免有效授权被误杀。
  - 开发与构建共用 `tauri.conf.json` 单一主配置，不存在独立开发配置污染生产包的风险。

> 现状更新（2026-09）：“后果与收益”中“TTL 六档”一词已过时。详情缓存 TTL 为 `config.toml` 单一基线（默认 30 分钟），不在设置页暴露（见 ADR-0007 与本 ADR 决策第 4 节），设置页无档位选项；第五组“恢复出厂设置”各处入口及对应命令已在需求精简中彻底移除，仅保留纯粹的数据备份；右下速率胶囊已从主界面隐藏收敛至账号卡片。决策原文历史归档保留。
