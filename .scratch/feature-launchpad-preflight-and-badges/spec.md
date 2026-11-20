# Feature Spec: 开源广场「应用内投稿预检向导」与「README 徽章 / 深链分享器」

> 状态：Implemented
> 关联契约：`CONTEXT.md`（D1 纯粹开源、D2 零服务器成本、D4 Linear 去彩单色界面、D8 首包验图）、`docs/count-display.md`（数量显示规范）、ADR-0006（多托管源 `ForgeProvider`）、ADR-0010（规范应用标识）、ADR-0018（开源协议门禁）、ADR-0029（开源广场社交发现与隔离清单）。

---

## 1. 核心目标与定位

完善 ZStore「帮开发者找到第一批用户」的双闭环工具链，将开源广场（Launchpad）从“仅能浏览与评论”升级为**「应用内一键投稿自检」+「外部 README 反哺引流」**：

1. **应用内投稿预检向导（`<LaunchpadSubmitModal>`）**：
   - 替换当前「提交我的开源作品 → 直接跳出外部浏览器空白表单」的盲填体验；
   - 开发者在客户端内输入仓库坐标（支持 GitHub / Codeberg / Gitea / GitLab）、分类、一句话自荐语（`maker_note`）与自定义图标直链，点击「运行上架预检」即可当场核验**公开仓库可达性、OSI 开源协议门禁、Release 可安装构建资产与平台推导、以及图标探测效果**，并在弹窗内**直接复用 `<LaunchpadCard>` 实时预览上架外观**；
   - 预检通过后一键唤起预填好全量表单字段（`repo_url`、`app_name`、`category`、`maker_note`、`maker_note_en`、`launch_tier`、`custom_icon_url`）的 `z-store-launchpad` Issue Form 页面。
2. **README 徽章与深链分享器（`<ShareBadgeModal>`）**：
   - 在开源广场卡片（`<LaunchpadCard>`）与详情页顶栏（`AppDetailModal/Header`）提供「分享 / 获取徽章」入口；
   - 一键复制 `zstore://launchpad/{id}`（或 `zstore://app/{id}`）协议深链、支持深/浅单色样式切换的 Shields Markdown 徽章与 HTML 嵌入代码，帮助开发者直接贴回项目 README 与发布帖向 ZStore 引流。

---

## 2. 架构边界与不变量

1. **不越权写上游仓库、保持零后端**：
   - 应用内投稿预检向导**不**代表用户直接调用 GitHub API 创建 Issue（`OAUTH_SCOPE` 保持 `public_repo user`，无需扩大写权限），仍通过系统浏览器打开预填参数后的 `submit-launchpad.yml` URL 由作者确认提交，完美契合 `z-store-launchpad` 的 Issue Ops 审校流程（ADR-0029）。
2. **协议门禁口径严格同源（ADR-0018）**：
   - 预检校验的开源协议名单直接读取 `config.toml [license_gate].allowed` 37 项 OSI SPDX 白名单（经 `config::normalize_license_token` 归一化），且对开源广场投稿强制按开启门禁口径核验（`enabled` 开关仅放行本地草稿，不放行官方开源广场）。
3. **无 Token 图标探测与 D8 首包验图**：
   - 图标探测沿用 `icons::probe` 与 `icons::image_sniff::sniff_image_mime` 首包魔数校验；自定义图标 URL 强制校验 `^https://`（拒绝 `http://` 与 `data:`），与 `z-store-launchpad` Schema 完全对齐。
4. **D4 单色视觉与计数规范**：
   - 弹窗统一基于 `<ModalShell>` 构建；徽章生成器提供 `#111111`（黑底白字）与 `#f4f4f5`（灰白底黑字）两种单色样式，禁止花哨彩色促销样式；
   - `maker_note` 字数统计与表单状态提示遵循去彩单色规范，列表统计统一使用 `<CountBadge>`。

---

## 3. 后端设计（`src-tauri/src/`）

### 3.1 `ForgeRepoInfo` 协议与作者头像补齐（`src-tauri/src/forge/`）
- 在 `ForgeRepoInfo`（`src-tauri/src/forge/provider.rs`）新增可选字段：
  ```rust
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub license: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub owner_avatar_url: Option<String>,
  ```
- 在 `GitHubProvider::fetch_repo`（`src-tauri/src/forge/github.rs`）、`GiteaProvider`、`GitLabProvider` 中补齐读取（GitHub 取 `license.spdx_id` 与 `owner.avatar_url`；未提供或返回 `NOASSERTION` 时保留原值供门禁明确拦截）。

### 3.2 `preflight_launchpad_submission` 命令（`src-tauri/src/commands/launchpad.rs`）

1. **命令签名**：
   ```rust
   #[tauri::command(rename_all = "camelCase")]
   pub async fn preflight_launchpad_submission(
       state: State<'_, AppState>,
       repo_url: String,
       custom_icon_url: Option<String>,
   ) -> crate::AppResult<LaunchpadPreflightResult>
   ```
2. **输出结构体（全字段 `snake_case`）**：
   ```rust
   #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
   #[serde(rename_all = "lowercase")]
   pub enum PreflightCheckKey { Coord, Duplicate, License, Release, Icon }

   #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
   #[serde(rename_all = "lowercase")]
   pub enum PreflightCheckStatus { Pass, Warn, Fail }

   #[derive(Debug, Clone, serde::Serialize)]
   pub struct PreflightCheckItem {
       pub key: PreflightCheckKey,
       pub status: PreflightCheckStatus,
       pub detail: String,
   }

   #[derive(Debug, Clone, serde::Serialize)]
   pub struct LaunchpadPreflightResult {
       pub ok: bool,
       pub canonical_id: String,
       pub forge: String,
       pub forge_host: String,
       pub owner: String,
       pub repo: String,
       pub repo_name: String,
       pub description: String,
       pub homepage: Option<String>,
       pub license: String,
       pub latest_version: String,
       pub platforms: Vec<String>,
       pub installable_asset_count: usize,
       pub has_checksum_manifest: bool,
       pub resolved_icon_url: String,
       pub stars: u64,
       pub forks: u64,
       pub maker_avatar_url: String,
       pub already_in_launchpad: bool,
       pub already_in_catalog: bool,
       pub checks: Vec<PreflightCheckItem>,
   }
   ```
3. **五步预检流水线**：
   1. **坐标解析与去重检查（`coord` & `duplicate`）**：
      - 调用 `crate::forge::RepositoryUrlParser::parse(&repo_url)` 与 `canonical_app_id`；解析失败立即返回 `ok = false`；
      - 检查 `CatalogService::is_cataloged(&canonical_id)` 置 `already_in_catalog`（`warn` 提示“已在精选库，仍可补充或建议直接完善目录”）；检查本地 `launchpad_feed_cache` 现行快照中的 `items` 是否已含该 ID 置 `already_in_launchpad`（`warn` 提示“已在开源广场上架”）；
   2. **仓库与 OSI 开源协议门禁（`license`）**：
      - 调用 `ForgeRegistry::fetch_repo`（使用活跃 Token 或无 Token 公共池）；
      - 校验 `license` 是否命中 `LicenseGateConfig::default().allowed`（即 37 项 OSI SPDX 列表，排除 `NOASSERTION`/`unknown`）；未通过则标记 `status = "fail"` 且整页 `ok = false`；
   3. **最新 Release 与可安装产物推导（`release`）**：
      - 调用 `ForgeRegistry::fetch_latest_release`；
      - 调用 `detail_assets::is_valid_installer_asset` 过滤出有效二进制分发包，统计 `installable_asset_count`、通过 `detail_assets::lite_platforms_for_github_assets` 推导 `platforms`，并检查是否存在校验清单文件（`checksums.txt` / `SHA256SUMS` / `.sha256`）置 `has_checksum_manifest`（缺失校验清单给 `warn` 提示而非硬拦截，与 D3 确认弹窗口径一致；完全无 Release 或 `platforms.is_empty() && installable_asset_count == 0` 标记 `status = "fail"` 且 `ok = false`）；
   4. **图标直链验证或自动探测（`icon`）**：
      - 若传入非空 `custom_icon_url`：先验证前缀必须为 `https://`，再通过无 Token CDN 客户端按 D8（`Range: bytes=0-65535` + `sniff_image_mime`）验图，失败标记 `warn` 或回落自动探测；
      - 未传时复用 `icons::probe_single_live`（或 SimpleIcons / Git Trees 探测）返回最佳可用 `https://` 图标 URL（探测为空时给 `warn` 提示“将使用默认首字母图标，建议补充图标直链”）。

---

## 4. 前端设计（`src/`）

### 4.1 API 与 Demo Mock 对齐
- `src/services/api.ts`：`CMD.preflightLaunchpadSubmission = 'preflight_launchpad_submission'`。
- `src/services/api/launchpad.ts`：新增 `preflightLaunchpadSubmission(repoUrl: string, customIconUrl?: string): Promise<LaunchpadPreflightResult>`（camelCase 键：`{ repoUrl, customIconUrl }`）。
- `src/demo/handlers/launchpad.ts` & `src/demo/tauri-mock.ts`：提供逼真的 Demo 预检响应（支持通过/协议不符/无 Release 三种可演示分支），保证 `cmdAlignment.test.ts` 与 `ipcArgsNaming.test.ts` 全绿。

### 4.2 应用内投稿预检向导（`src/views/LaunchpadView/LaunchpadSubmitModal.tsx`）
- **入口**：在 `LaunchpadView.tsx` 的「提交我的开源作品」`<FlyoutMenu>` 中将「应用内预检并投稿（推荐）」设为首选项，点击打开 `<LaunchpadSubmitModal>`；保留原有的直接外链入口作为 fallback。
- **弹窗结构（基于 `<ModalShell>`）**：
  - **表单区**：
    - 仓库地址输入（支持输入 `owner/repo` 或完整 URL；登录态可一键填入当前用户名前缀 `@{login}/`）；
    - 应用显示名称（自动从预检仓库名填充，可微调）；
    - 10 大标准分类下拉选择器（对齐 `z-store-launchpad` 的下拉文案）；
    - 作者中文自荐语 `maker_note`（单行禁止换行，上限 `140` 字符实时校验）与可选英文 `maker_note_en`；
    - 推广档位选择（`free` / `spotlight-7d` / `spotlight-14d` / `spotlight-30d`）与可选自定义 `https://` 图标地址；
  - **预检结果与实时卡片预览区**：
    - 点击「运行上架预检」调用 `preflightLaunchpadSubmission`；
    - 展示 4~5 条单色状态检查项（`CheckCircle2` / `AlertTriangle` / `XCircle`）；
    - 将用户输入与预检结果实时组装为一条 `LaunchpadEntry`（`is_pinned` 随 `launch_tier` 实时切换），**直接调用 `<LaunchpadCard>` 以禁用交互预览模式渲染**，让作者直观确认标题、自荐语截断、平台图标与图标渲染效果；
  - **提交出口**：
    - 预检通过（`ok === true`）且表单必填项合法后，点击「前往 GitHub 确认提交」，使用纯函数 `buildLaunchpadIssueUrl` 按 `submit-launchpad.yml` 的字段 ID（`title`, `repo_url`, `app_name`, `category`, `maker_note`, `maker_note_en`, `launch_tier`, `custom_icon_url`）拼接编码 URL 并调用 `tauriApi.openUrl`。

### 4.3 README 徽章与深链分享器（`src/components/ShareBadgeModal.tsx`）
- **纯函数构建器（`src/utils/shareBadge.ts`）**：
  - 支持两种目标类型：`kind: 'launchpad' | 'catalog'`；
  - 生成协议深链：`zstore://launchpad/{id}` 或 `zstore://app/{id}`；
  - 生成单色 Shields 徽章 URL（支持 `dark` `#111111` 与 `light` `#f4f4f5` 两种单色样式）、Markdown 徽章与 HTML `<a><img></a>` 代码（点击跳转链接优先提供官网着陆引导链接 `https://z-store-web.pages.dev` 或 `zstore://` 深链选项，避免 GitHub README 过滤非 `https://` 协议造成点击无效的常见陷阱，并在弹窗内单独一行展示原生 `zstore://` 深链供支持协议的环境或粘贴到论坛/社交媒体的用户使用）。
- **入口挂载**：
  - `src/views/LaunchpadView/LaunchpadCard.tsx`：底部操作栏增加单色分享图标按钮（`Share2`）；
  - `src/components/AppDetailModal/Header.tsx`：顶栏操作按钮区增加单色分享图标按钮；
  - 点击均打开 `<ShareBadgeModal>`（`layer="confirm"` 若从弹窗内打开、`base` 若从列表卡片打开，防止被 `AppDetailModal` 遮挡）。

---

## 5. 测试与验收门槛

1. **Rust 单测**：
   - `preflight_launchpad_submission` 纯决议逻辑与 mock 端点测试：覆盖合法仓库（MIT + 有效 Release + 图标命中）、非 OSI 协议（`NOASSERTION` / 商业协议拦截）、无 Release 资产拦截、非法 `http://` 自定义图标拦截、重复上架告警。
2. **前端单测**：
   - `buildLaunchpadIssueUrl` 参数编码对齐 `submit-launchpad.yml` 字段名测试；
   - `LaunchpadSubmitModal.test.tsx`：预检状态渲染、实时 `<LaunchpadCard>` 预览、不合法阻断提交、合法唤起 `openUrl`；
   - `ShareBadgeModal.test.tsx` & `shareBadge.test.ts`：深浅单色徽章 URL、Markdown/HTML 片段与 `zstore://launchpad/...` / `zstore://app/...` 复制；
   - `cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`countDisplay.test.ts`、`views.i18n.test.tsx` 全绿。
