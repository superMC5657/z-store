# ADR-0010: 以 owner/repo 作为全局唯一应用标识 (Canonical App Identifier)

- 状态: Accepted
- 日期: 2026-09-14
- 关联: ADR-0006 (多 Forge 支持)、ADR-0007 (开放清单目录)、ADR-0009 (清单仓库解耦)

## 背景

应用标识（AppId）贯穿 Z-Store 全链路：清单条目、深链、收藏/关注/更新规则、已安装记录、
详情缓存与便携版安装目录命名。`id` 统一为小写 `owner/repo`（非 GitHub 源为 `forge:owner/repo` 形态），即仓库坐标本身。

为兼容多种形态，客户端散布着多层隐式兜底：目录双匹配（slug 或 owner/repo）、
DB 查询统一 `LOWER(app_id)`、详情缓存 `app_id + repo_key` 双键镜像行。
同一应用从不同入口进入时，可能在收藏、关注、更新规则等以 `app_id` 为主键的
表中产生互不相认的重复记录（数据碎片化）；且 repo 改名后 slug 与仓库坐标静默脱节。

## 决策

1. **canonical id = 小写 `owner/repo`**（GitHub 应用）；非 GitHub 源沿用
   `UniversalRepoCoord::to_app_id()` 既有格式：默认 host 的其它 Forge 为
   `forge:owner/repo`，自建 host 为 `forge:host/owner/repo`。
   该函数从"多源兼容工具"转正为全系统唯一标识规范。

2. **不使用显示名 `name` 参与标识**：显示名随品牌改名/本地化变化，不稳定；
   `owner/repo` 由托管平台保证唯一，且 id 即坐标本身——单一事实来源，
   消除 id ↔ 坐标映射漂移的可能。

3. **不采用 UUID/随机 hash**：可读性对深链（`zstore://app/localsend/localsend`）、
   开放清单仓库的社区 PR review 均为硬需求；主流同类系统（winget 的
   `Publisher.PackageName`、homebrew/scoop 的 formula/slug）亦均采用有意义稳定标识。

4. **数据库只存 canonical id；目录检索仅按 id 匹配**。

5. **入站归一化（系统边界契约）**：所有来自前端的 `app_id` 在 Tauri 命令入口
   统一调用 `crate::forge::canonical_app_id()`：完整仓库 URL / Forge 前缀短语法 /
   裸 owner-repo 一律解析为 canonical 形态并统一小写，无法解析时原样小写兜底。
   数据库从此只存 canonical id；目录检索（`get_catalog_item` 等）仅按 id
   唯一匹配。

6. **清单格式**：catalog.json 的 `id` 字段为小写 `owner/repo`；
   `validate-catalog.mjs` 强制校验 `id === owner/repo` 与全库唯一。

## 配套调整

- **便携版目录命名**：canonical id 含 `/`，目录名消毒规则将 `/` 折叠为 `-`
  （`rustdesk/rustdesk` → `rustdesk-rustdesk`）。
- **扫描器**：扫描器由 `repo`/`name` 字段派生候选。
- **详情缓存**：`app_details_cache` 为 canonical id 单键精确匹配。

## 后果

- 正面：全系统单一 id 形态，消除多格式碎片化与 id↔坐标漂移；清单条目
  自校验（id 必须与坐标一致）；检索逻辑大幅简化（单一匹配路径）。
- 中性：非 GitHub 源收录清单条目为未来扩展，届时 `id` 采用 `forge:owner/repo`
  形态，归一化链路无需变更。
