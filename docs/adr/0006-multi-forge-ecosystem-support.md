# ADR-0006: 多源代码托管平台 (Multi-Forge) 生态支持与统一抽象层

- **状态**: Accepted
- **日期**: 2026-09-04
- **决策者**: 架构与产品团队

## 上下文

Z-Store 最初以 GitHub Releases 为唯一软件分发来源（ADR-0002 与基石决策 D1、D2）。然而随着开源生态演进，大量优秀知名开源项目（如 FreeTube、Penpot、OpenHub 等）出于开源自治与服务中立考量，已将官方主发布渠道迁移至 Codeberg、Forgejo 以及自建 Gitea 或 GitLab 实例。

为了保持 Z-Store 作为跨平台开源应用商店的包容性与长远生命力，必须打破对单一代码托管平台的硬编码依赖，演进为支持多代码源（Multi-Forge）的通用架构。

## 决策

1. **演进基石架构原则 D1 与 D2**：
   - **D1 (Strictly FLOSS)**：收录和分发托管于 GitHub、Codeberg、Gitea、GitLab 等符合开源自治原则平台且拥有 OSI 认证开源协议的软件。
   - **D2 (Serverless Direct Multi-Forge API)**：客户端直接与各代码托管平台的 REST API 进行零中介直连通信，依然不依赖任何中心化转接服务器。

2. **统一抽象层 `ForgeProvider` Trait**：
   - 抽象 `ForgeProvider` 接口，规范 `fetch_repo`、`fetch_latest_release` 与 `search_repos` 三大核心方法。
   - 原生实现 `GitHubProvider`、`GiteaProvider`（全面兼容 Codeberg 与 Forgejo REST API v1）与 `GitLabProvider`（支持 GitLab API v4）。
   - 通过 `ForgeRegistry` 根据 URL 或仓库坐标的主机域名透明路由至对应的提供者实例。

3. **通用坐标与 URL 智能解析 (`UniversalRepoCoord`)**：
   - 规范通用坐标格式：`host:owner/repo`，默认缺省 host 时视为 `github.com` 以向下兼容已有数据库与精选收录库。
   - 实现 `RepositoryUrlParser`，支持用户在全局搜索栏直接粘贴任意受支持源站的仓库链接实时解析与下载安装。

4. **多主机访问令牌与速率限制感知 (`host_tokens`)**：
   - 在本地 SQLite 中通过 `host_tokens` 表独立管理各托管主机（如 `codeberg.org`、自建域名等）的访问凭证与 Rate Limit 配额状态。

## 后果与收益

- **积极收益**：无缝覆盖更广泛的去中心化开源项目，满足非 GitHub 托管软件的分发与自动更新需求。
- **代价与防护**：多源 API 响应结构存在细微差异，需在各 `ForgeProvider` 实现中统一映射为规范的 `ForgeRepoInfo`、`ForgeReleaseInfo` 与 `ReleaseAsset` 数据模型。
