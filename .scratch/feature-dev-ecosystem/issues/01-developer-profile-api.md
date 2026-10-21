# Issue 01: 开发者全景数据接入与 IPC 命令

Status: resolved

## 描述

实现查询指定 GitHub 开发者或组织全景资料与开源矩阵的能力：
1. 数据模型与契约：
   - `DeveloperProfile`: 包括 `login`, `name`, `avatar_url`, `html_url`, `bio`, `company`, `blog`, `location`, `public_repos`, `followers`, `following`, `repos: Vec<DeveloperRepoItem>`；
   - `DeveloperRepoItem`: 包括 `id` (`owner/repo`), `name`, `full_name`, `description`, `html_url`, `stars`, `forks`, `language`, `has_releases`, `in_catalog`, `latest_release_tag`。
2. GitHub API 请求与解析：
   - 接入 `https://api.github.com/users/{developer}` 获取用户信息；
   - 接入 `https://api.github.com/users/{developer}/repos?sort=updated&per_page=30` 获取其开源仓库列表；
   - 交叉比对本地 `catalog.json`，自动标记 `in_catalog: true` 并关联已知信息；
   - 结合 `etag_cache` 表，复用已有的 HTTP ETag 缓存机制。
3. Tauri 注册 IPC 命令：
   - `get_developer_profile(developer: String) -> Result<DeveloperProfile, String>`。
4. 单元测试覆盖解析与 Mock 逻辑。

## Comments

- 无 Token 时使用匿名公共接口（带 User-Agent），已配置 Token 时自动附带鉴权以享受 5000 次/小时高配额。

## Answer

已在后端实现完整的开发者全景数据接入链路：
1. 在 `models.rs` 中定义了 `DeveloperProfile` 与 `DeveloperRepoItem`；
2. 在 `github.rs` 中实现 `fetch_developer_profile(developer, token)`，自动获取用户或组织的公开信息与名下仓库，并与本地 `catalog.json` 进行交叉匹配，标注收录状态与默认版本，同时支持离线/限流场景自动兜底；
3. 在 `commands.rs` 中实现 `get_developer_profile` 命令并在 `lib.rs` 中注册；
4. 编写了 `test_fetch_developer_profile_fallback` 异步测试用例并成功通过。

