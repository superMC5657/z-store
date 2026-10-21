# Feature A: 多源代码托管平台支持 (Multi-Forge Ecosystem Specification)

## 1. 目标与背景

随着开源生态的发展，越来越多的开源项目（如 FreeTube、OpenHub、Penpot 等）向 Codeberg、Forgejo 及自建 Gitea/GitLab 迁移。
借鉴 Komi Store 的 Multi-Forge 架构经验，Z-Store 打破对单一 GitHub 的硬编码依赖，构建通用的 `ForgeProvider` 抽象层与解析注册引擎，实现原生跨平台 Git 托管源直连与统一发布包安装。

## 2. 核心架构与功能模块

1. **通用 Forge 抽象 Trait 与注册中心 (`forge-provider-trait`)**
   - 抽象 `ForgeProvider` Trait：支持 `fetch_repo_info`、`fetch_latest_release`、`search_repos`；
   - 原生实现 `GitHubProvider` 与 `GiteaProvider`（全面兼容 Codeberg 与 Forgejo REST API 标准）；
   - 提供 `ForgeRegistry` 工厂，根据仓库主机域名路由到对应的提供者实例。

2. **通用仓库唯一标识与 URL 解析器 (`universal-repo-identifier-and-schema`)**
   - 实现 `RepositoryUrlParser`：从用户输入的完整链接（如 `https://codeberg.org/owner/repo`）或特定格式（`codeberg:owner/repo`、`owner/repo`）中自动识别代码源、主机与所属仓库坐标；
   - 统一标识符规范：采用 `host:owner/repo` 逻辑，同时向下兼容已有数据库中的纯字符串 `app_id`（未指定 host 时默认视为 `github`）。

3. **多平台 Token 管理与 API 速率感知器 (`multi-host-pat-and-rate-limit`)**
   - SQLite 增加 `host_tokens` 表，安全存储不同主机域名（如 `github.com`、`codeberg.org`、自建域名）的独立访问令牌与速率限制配额状态；
   - 提供 Tauri IPC 命令管理主机 Token：增删查改及配额检测。

4. **前端多源图标徽章与自建实例接入配置 (`forge-badge-and-custom-instances-ui`)**
   - 卡片与详情页展示源站平台图标徽章（🐙 GitHub、🏔️ Codeberg、🍵 Gitea、🦊 GitLab）；
   - 在设置中心增加「🌐 多源代码托管与 API 令牌管理」面板，支持自定义添加私有 Gitea/Forgejo 域名与 Token；
    - > 校准（以代码为准）：后端已支持多 host token（`get/set/removeHostTokens` IPC）+ 自定义 host 解析为 Gitea（`forge/coord.rs`），设置中心 UI 未暴露，为后续项。
   - 顶部搜索框支持粘贴任意受支持源站的仓库 URL 实时解析。
