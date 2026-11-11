# ADR-0006: 多源代码托管平台 (Multi-Forge) 生态支持与统一抽象层

- **状态**: Accepted
- **日期**: 2026-09-04
- **决策者**: 架构与产品团队

## 上下文

开源软件分发覆盖 GitHub Releases、Codeberg、Forgejo、自建 Gitea 与 GitLab 等多个代码托管平台。为了原生支持多源代码托管生态，客户端采用与具体平台解耦的 Multi-Forge 通用抽象架构。

## 决策

1. **基石架构原则 D1 与 D2 的多源语义**：
   - **D1 (Strictly FLOSS)**：收录和分发托管于 GitHub、Codeberg、Gitea、GitLab 等开源托管平台且拥有 OSI 认证开源协议的软件。
   - **D2 (Serverless Direct Multi-Forge API)**：客户端直接与各代码托管平台的 REST API 进行零中介直连通信，不依赖任何中心化转接服务器。

2. **统一抽象层 `ForgeProvider` Trait**：
   - 抽象 `ForgeProvider` 接口，规范 `forge_type`、`fetch_repo` 与 `fetch_latest_release` 核心方法。
   - 原生实现 `GitHubProvider`、`GiteaProvider`（兼容 Codeberg 与 Forgejo REST API v1）与 `GitLabProvider`（支持 GitLab API v4）。
   - 通过 `ForgeRegistry` 根据 URL 或仓库坐标的平台类型与主机域名路由至对应的提供者实例。

3. **通用坐标与 URL 智能解析 (`UniversalRepoCoord`)**：
   - 规范通用 canonical 坐标格式（见 ADR-0010 与 `forge/coord.rs`）：GitHub 使用小写 `owner/repo`；非 GitHub 默认主机使用 `forge:owner/repo`；自建实例使用 `forge:host/owner/repo`；`gh:` / `cb:` / `gl:` / `gt:` 作为入站短语法别名统一归一为 canonical 形态。
   - 实现 `RepositoryUrlParser`，支持解析各受支持平台仓库 URL 并在全局搜索与详情页直接获取、安装与更新。

4. **多主机速率记录与只读令牌读取 (`host_tokens`)**：
   - 在本地 SQLite `host_tokens` 表中按主机持久化 Rate Limit 配额快照（`rate_limit_remaining`、`rate_limit_limit`、`rate_limit_reset`）供配额监控事件 `zstore://quota-updated` 使用；若表中存在对应主机的非空 `token` 记录，后端各平台 API 请求路径按只读方式携带（前端不暴露 PAT 读写或测试命令）。

## 后果与收益

- **积极收益**：无缝覆盖更广泛的去中心化开源项目，满足非 GitHub 托管软件的分发与自动更新需求。
- **代价与防护**：多源 API 响应结构存在细微差异，需在各 `ForgeProvider` 实现中统一映射为规范的 `ForgeRepoInfo`、`ForgeReleaseInfo` 与 `ReleaseAsset` 数据模型。
