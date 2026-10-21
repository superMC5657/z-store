# Issue 01: 抽象 ForgeProvider 通用 Trait 与提供者注册工厂

Status: resolved

## 描述

在 Rust 后端抽象通用的代码托管源接口与实现：
1. 模块设计与抽象：
   - 新建 `src-tauri/src/forge.rs` 模块；
   - 定义枚举 `ForgeType`：`GitHub`, `Codeberg`, `Gitea`, `GitLab`；
   - 抽象异步 Trait `ForgeProvider: Send + Sync`：
     - `fn forge_type(&self) -> ForgeType;`
     - `fn default_host(&self) -> &str;`
     - `async fn fetch_repo(&self, host: &str, owner: &str, repo: &str, token: Option<&str>) -> Result<ForgeRepoInfo, String>;`
     - `async fn fetch_latest_release(&self, host: &str, owner: &str, repo: &str, token: Option<&str>) -> Result<ForgeReleaseInfo, String>;`
2. 实现提供者：
   - `GitHubProvider`：封装 GitHub REST API v3 规范；
   - `GiteaProvider`：封装 Gitea / Forgejo / Codeberg 标准 REST API v1 规范（如 `/api/v1/repos/{owner}/{repo}/releases/latest`）；
3. 工厂与分发器：
   - `ForgeRegistry`：根据 host 或平台标识自动路由到对应 Provider。
4. 编写单元测试验证 Gitea/Codeberg 与 GitHub API 资产解析逻辑。

## Comments

- Codeberg 使用标准的 Gitea v1 API，其发布资产直接映射为 Release assets，完全可以统一复用安装管道。

## Answer

已完成通用 ForgeProvider 抽象与实现：
1. 新建 `src-tauri/src/forge.rs`，定义了 `ForgeType`、`ForgeRepoInfo`、`ForgeReleaseInfo` 与异步 Trait `ForgeProvider`；
2. 实现了 `GitHubProvider` 与 `GiteaProvider`，原生兼容 Codeberg、Forgejo 及私有 Gitea 实例；
3. 实现了 `ForgeRegistry` 统一路由分发器；
4. 单元测试 `test_forge_type_metadata` 验证通过。

