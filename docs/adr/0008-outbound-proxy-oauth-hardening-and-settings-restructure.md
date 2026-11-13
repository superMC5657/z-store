# ADR-0008: 出站代理与 OAuth 加固及设置页重组与开发配置隔离

- **状态**: Accepted
- **日期**: 2026-09-07
- **决策者**: 架构与产品团队

## 上下文

- `github.com` 直连受阻时，Device Flow 端点（`DEVICE_CODE_URL`、`ACCESS_TOKEN_URL`）与 API 轮询需要无缝继承操作系统代理或本地 TUN 通道。
- OAuth Client ID 需要支持统一默认配置与用户级设置覆盖。
- 轮询响应需要将 `Expired` 与 `Denied` 等状态拆分为明确状态机，给出可解释的用户引导。
- 设置页需清晰分区呈现外观、更新、存储、网络与数据管理配置。
- 开发模式与生产构建需要清晰隔离 Dev HMR 地址与生产收紧策略。

## 决策

1. **网络代理（系统代理自动继承与本地截获）**：
   - **架构说明**：无应用内出站代理配置项；API 与登录走系统代理透明截获，大文件下载走下载加速代理。
   - **保留系统代理静默预热**：
     - `normalize_windows_proxy_server` 解析注册表多协议形态，`https` 命中即取用并跳出，其次取 `http`、其他协议、裸地址。
     - 启动时经 `init_windows_system_proxy` 预热（依赖 `winreg 0.56.0`），确保 reqwest 自动对齐 Windows 注册表配置的系统代理。
     - 纯系统级透明接管，无需用户在应用内繁琐维护本地代理地址。
     - 稳健性声明：IPv6 裸地址补中括号、GNOME socks 缺省 `socks5h://`（远端解析防 DNS 泄漏）、桌面条目 `TryExec` 回退解析与 `Icon` 仅保留绝对路径。

2. **网络代理与下载加速代理辨析（正交解耦）**：
   - 系统网络代理：由 OS / 代理软件接管，全透明转发 API 与登录请求。
   - 下载加速代理（`active_mirror`、`custom_proxy`，`mirror.rs` 的 `MirrorManager`）：只管 GitHub Release 二进制大文件下载 URL 前缀重写（如 `https://gh-proxy.com`）。
     - `direct` 为官方直连，`https://gh-proxy.com` 为常用加速前缀。
     - 测速结果阈值为 `400ms` 与 `1000ms`：低于 `400ms` 为绿，高于 `400ms` 为黄，高于 `1000ms` 为橙，失败为红（设置页代理行内联指示）。
   - 一句话区分：API与登录走系统代理透明截获；大文件下载慢在设置页切换下载加速代理。
   - 直连豁免：`gh-proxy.com`（镜像下载前缀）与 `trend.doforce.dpdns.org`（趋势 API）经 per-client `no_proxy` 直连，不走镜像；镜像切换永不写进程全局 `NO_PROXY`/`no_proxy`（仅 per-client 生效，见 `proxy::apply_proxy`）。

3. **OAuth 加固（Device Flow）**：
   - Client ID 二级优先级公式为设置覆盖优先：
     - `github_oauth_client_id`（`SETTING_OAUTH_CLIENT_ID`）大于 `config.toml [oauth].default_client_id`（当前为 `Ov23lik0b7fDGMLTiOYH`）。
     - 实现为 `resolve_oauth_client_id`（`oauth/mod.rs`）与 `resolve_oauth_client_id_from_db`（`commands/mod.rs`）；无编译期环境变量注入。
   - 占位拦截文案固定：
     - 占位值为 `YOUR_CLIENT_ID_HERE`（`OAUTH_CLIENT_ID_PLACEHOLDER`，`oauth/mod.rs`）。
     - `oauth_device_start`（`commands/oauth.rs`）命中占位直接返回 `尚未配置 GitHub OAuth Client ID，请在「设置」中填写后重试`。
   - 五态表由 `DevicePollOutcome` 承载（`oauth/mod.rs`），解析为 `classify_device_poll`（`oauth/mod.rs`）：
     - `Pending`：对应 `authorization_pending` 与 `slow_down`。
     - `Authorized`：携带 `access_token`，空令牌不算授权。
     - `Expired`：对应 `expired_token`，文案为 `设备验证码已过期，请重新开始授权`。
     - `Denied`：对应 `access_denied`，文案为 `用户拒绝了授权请求`。
     - `Error`：未知错误透出 `error_description`，非 JSON 体提示轮询响应无法解析。
     - 前端 `services/api/social.ts::oauthDevicePoll` 把响应归一为 `authorized/pending/expired/denied/error` 五态，`OAuthAccountCard` 在 `authorized` 分支收尾登录，其余按错误态展示。
   - 协议常量固定：
     - 端点为 `https://github.com/login/device/code`（`DEVICE_CODE_URL`）与 `https://github.com/login/oauth/access_token`（`ACCESS_TOKEN_URL`），定义于 `oauth/mod.rs`。
     - 权限为 `OAUTH_SCOPE = "public_repo user"`（`oauth/mod.rs`），覆盖 Star 与 Star 清单管理。
     - 发起与轮询复用共享 HTTP 客户端统一 API 超时（`config.toml` 的 `api_timeout_seconds`，默认 `12s`；实现经 `shared_http_client`，见 `oauth/mod.rs`），无独立 `10s` 超时。
   - 前端容错为连续 `10` 次失败才停：
     - `OAuthAccountCard` 以 `pollFailRef` 计数，抖动只提示 `网络波动，自动重试中` 并继续下一轮。
     - 攒够 `10` 次才停轮询，且保留用户码展示，提示检查网络后取消重来。
     - 轮询间隔下限为 `Math.max(1000, interval * 1000)`。
   - 成功即自动拉起浏览器兜底：
     - `handleLogin` 成功后调 `api.openUrl(verificationUri)`（`OAuthAccountCard.tsx`，经 `services/api/settings.ts::openUrl`，由 `services/api.ts` 再导出）。
     - 拉起失败不阻塞，卡片保留手动前往授权页按钮。
   - Client ID 默认值来源：
     - 默认值收敛于 `config.toml [oauth].default_client_id` 单一配置源；`.github/workflows/release-tauri.yml` 不注入任何 OAuth Client ID 变量，不存在编译期环境变量覆盖。
     - 该值为公开标识，非密钥；访问令牌只存 `user_settings.github_oauth_token`（`SETTING_OAUTH_TOKEN`），永不打印日志。

4. **设置页重组为六组**：
   - 第一组为外观（`AppearanceSection`）：主题、语言、界面缩放、全局字号。
   - 第二组为更新与规则（`UpdatesRulesSection`）：更新频率、客户端更新行、关注提醒频率、版本锁定规则入口。
   - 第三组为存储与安装（`StorageSection`）：下载目录、便携版安装目录；图标与通用资源缓存由系统后台自动淘汰管理，不在设置页暴露清理项。
   - 第四组为网络（`NetworkDataSection`）：GitHub 账号卡片（`OAuthAccountCard`，锚点 `settings-account`）、下载加速代理与单键测速、收录清单同步。
   - 第五组为用户画像（`AffinityPrivacyRow`，锚点 `settings-affinity`）：本地亲和度画像的隐私数据看板、本地应用信息与 GitHub 用户信息两个推荐信号源开关、立即增量同步与推荐反馈清空。
   - 第六组为数据与备份（`DataManagementSection` → `DataBackupRow`）：导出与备份统一操作行（应用列表 JSON 导出、用户数据导出/导入、脱敏诊断日志导出与日志目录打开入口；三项导出均弹出系统保存对话框并默认定位至日志目录）。
   - 状态指示保留：账号卡片内展示登录态的配额说明文案与锚点跳转。
   - 详情缓存 TTL 由 `config.toml` 单一基线控制（基线 60 分钟，30 为非法挡位故按 60 生效），不在设置页暴露调节项（缓存策略详见 ADR-0007）。

5. **开发与构建配置（单一主配置 `src-tauri/tauri.conf.json`）**：
   - 开发与生产构建共用主配置 `src-tauri/tauri.conf.json`，无独立开发配置文件。
   - 开发地址收敛于主配置：`devUrl` 为 `http://localhost:1420`，`beforeDevCommand` 为 `pnpm dev`。
   - 开发启动命令为 `pnpm tauri dev`（直接使用 `@tauri-apps/cli`），无 `--config` 叠加文件；生产构建为 `pnpm tauri build`。

## 后果与收益

- **积极收益**：
   - 网络自适应：系统代理自动探测与 TUN 本地截获打通，无额外手动配置心智负担。
   - 登录可解释：五态分离后，过期、拒绝、网络抖动各有明确文案与下一步动作。
   - 设置可找到：六组分区降低滚动查找成本，用户画像与数据导出/备份边界清晰，代理辨析与 TTL 挡位一次讲清。
    - 开发可热更：开发 CSP 放行 localhost HMR。
- **代价**：
   - Client ID 二级覆盖增加排查链路，出问题需先确认生效的是哪一级。
- **防护**：
  - 非法代理地址在入库前拦截，错误文案直接定位缺主机名、缺端口、不支持协议。
  - 占位值拦截阻止无效 Device Flow 发起，避免用户对着失效二维码等待。
  - 轮询 `10` 次熔断防止无限重试，用户码保留避免有效授权被误杀。
  - 开发与构建共用 `tauri.conf.json` 单一主配置，不存在独立开发配置污染生产包的风险。
