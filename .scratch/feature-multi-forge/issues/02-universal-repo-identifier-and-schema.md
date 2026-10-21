# Issue 02: 跨平台仓库唯一标识与数据库向下兼容方案

Status: resolved

## 描述

设计并落地跨多托管源的仓库唯一坐标与 URL 解析器：
1. 规范与数据结构：
   - 定义 `UniversalRepoCoord`: 包括 `forge: ForgeType`, `host: String`, `owner: String`, `repo: String`；
   - 序列化与格式化方法：`to_string()` 输出规范格式（如 `codeberg:owner/repo`，自建源 `gitea@git.example.com:owner/repo`，默认省略 host 则为 `github`）；
   - 从既有纯字符串 `app_id` 无缝反序列化，若无前缀默认映射为 `github.com`，保持已有 SQLite 记录 100% 兼容。
2. URL 启发式解析器 (`RepositoryUrlParser`)：
   - 提取用户粘贴的 URL：
     - `https://github.com/{owner}/{repo}` -> GitHub
     - `https://codeberg.org/{owner}/{repo}` -> Codeberg
     - `https://git.disroot.org/{owner}/{repo}` -> Gitea/Disroot
     - `https://gitlab.com/{owner}/{repo}` -> GitLab
   - 支持简写语法：`codeberg:owner/repo`, `gh:owner/repo`。
3. 单元测试覆盖各种标准 URL、带结尾斜杠、带 `.git`、前缀语法及边界情况。

## Comments

- 严格保持 SQLite 中 `installed_apps`、`update_rules`、`user_favorites` 表现有数据向下兼容。

## Answer

已完成跨平台仓库唯一标识与 URL 解析器：
1. 在 `forge.rs` 中实现了 `UniversalRepoCoord`，支持双向生成并解析跨平台标准标识（如 `codeberg:owner/repo`、自建域名 `gitea:host/owner/repo` 以及传统 GitHub `owner/repo`）；
2. 实现了 `RepositoryUrlParser::parse`，支持自动清洗协议前缀、`.git` 后缀、结尾斜杠并映射对应 Forge 平台；
3. 单元测试 `test_repository_url_parser` 覆盖了 Codeberg Web URL、GitHub .git URL、自建 Gitea/Disroot 域名及前缀短语法全部用例。

