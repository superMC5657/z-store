# ADR-0010: 以 owner/repo 作为全局唯一应用标识 (Canonical App Identifier)

- 状态: Accepted
- 日期: 2026-09-14
- 关联: ADR-0006 (多 Forge 支持)、ADR-0007 (开放清单目录)、ADR-0009 (清单仓库解耦)

## 背景

应用标识（AppId）贯穿 Z-Store 全链路：清单条目、深链、收藏/关注/更新规则、已安装记录、详情缓存与便携版安装目录命名。如果允许同一应用在不同入口使用多种别名、大小写或外部网址形态而不先做归一化，会导致收藏、关注、更新规则与详情缓存出现重复键碎片化，因此全系统以单一 canonical 规范统一收敛。

## 决策

1. **canonical id 格式**：GitHub 应用采用小写 `owner/repo`；非 GitHub 源采用 `UniversalRepoCoord::to_app_id()` 定义：默认主机为 `forge:owner/repo`，自建主机为 `forge:host/owner/repo`。该函数为全系统唯一标识规范。

2. **不使用显示名 `name` 参与标识**：显示名可能随品牌或本地化变动；`owner/repo` 由托管平台保证唯一，且 id 即坐标本身，确保单一事实来源。

3. **不采用 UUID/随机 hash**：可读性是深链（`zstore://app/localsend/localsend`）与开放清单仓库社区 PR 审阅的硬需求（类似 winget 的 `Publisher.PackageName`、homebrew/scoop 的 formula/slug）。

4. **数据库只存 canonical id；目录检索仅按 id 精确匹配**。

5. **入站归一化（系统边界契约）**：所有来自前端的 `app_id` 在 Tauri 命令入口统一调用 `crate::forge::canonical_app_id()`：完整仓库 URL / Forge 前缀短语法 / 裸 owner-repo 均解析为 canonical 形态并统一小写；无法解析的标识由 `require_app_id` 直接拒绝，不静默兜底。

6. **清单格式**：`catalog.json` 的 `id` 字段遵循小写 canonical 形态（由独立生态清单仓库 CI 负责入库唯一性与格式校验）。

7. **深链入站归一化**：`DeepLinkParser::parse` 对 `app` / `install` / 裸 id 三路由统一经 `forge::canonical_lookup_id()` 归一——可解析直取 canonical（大小写、完整 URL 形态收敛），不可解析回退小写，解析层不断路由；执行层 `require_app_id` 拒绝非法标识。

8. **单一生成函数**：`canonical_app_id` 为唯一入口（`(owner, repo)` 经 `canonical_app_id_from_parts`，`icon_key` 薄委托到同源归一化），确保 DB 主键、事件 key 与前端归一键同值。

## 配套结构

- **便携版目录命名**：canonical id 含 `/`，目录名消毒规则将 `/` 折叠为 `-`（`rustdesk/rustdesk` → `rustdesk-rustdesk`）。
- **扫描器**：扫描器由 `repo`/`name` 字段派生候选。
- **详情缓存**：`app_details_cache` 为 canonical id 单键精确匹配。
- **深 join 模块**：未收录 join（`(favorite∪watched)∖精选收录库`）与 scanner 模糊评分均基于 canonical id 执行。

## 后果

- 正面：全系统统一 id 形态，避免多格式键分裂与坐标漂移，且清单条目可直接自校验。
- 中性：非 GitHub 源收录条目采用 `forge:owner/repo` / `forge:host/owner/repo` 形态，归一化链路统一处理。
