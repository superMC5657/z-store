# Issue 01: GitHub 信号真实时间戳解析与未收录本地详情摘要读取

Status: resolved
Blocked by: none

## 背景

1. 现行 `sync_github_affinity_signals_bg`（`src-tauri/src/github/affinity.rs`）把同步时刻 `now` 统一赋给全部页的 `UserRepoSignal.updated_at`，导致数年前 Star 的旧仓库与今日新 Star 拥有完全相同的衰减权重 `1.0`，且同分种子按 `id` 字母序破平失真。
2. 用户对未收录应用（来自趋势榜或在线搜索）产生收藏、关注、安装或浏览时，`app_details` 表已存有概要元数据，但 `RawAffinitySignals` 未将其读出，导致后续画像无法消费这些本地信号。

## 目标

1. **GitHub `/user/starred` 真实标星时间与向后兼容解析**：
   - 在 `sync_github_affinity_signals_bg` 请求 `/user/starred` 分页端点时，基于 `bearer_headers` 覆写 `Accept: application/vnd.github.star+json`；
   - 新增兼容反序列化结构（如 `#[serde(untagged)] enum StarredPageItem`），同时支持带时间戳包装 `{ starred_at: Option<String>, repo: GitHubRepoResponse }` 与旧版裸 `GitHubRepoResponse` 两种 JSON 数组元素；
   - 使用 `time::OffsetDateTime::parse(..., &time::format_description::well_known::Rfc3339)` 解析 `starred_at` 为 Unix 秒级时间戳；若缺失或解析失败，按分页全局 0-based 序号 `global_idx` 回退计算单调递减时间 `now.saturating_sub((global_idx as i64) * 3600)`，消除全表同时间戳导致的字母序偏置；
   - 若本地 `api_etag_cache` 中的旧缓存载荷（`cached_payload`）非空但不含 `"starred_at"` 子串，在请求该页时将 `cached_etag` 置为 `None`，平滑触发一次 `200 OK` 升级缓存格式（若服务端仍返回裸格式或 `304`，兼容解析器依旧正常工作）。
2. **GitHub `/user/repos` 真实活跃时间解析**：
   - 在 `src-tauri/src/github/models.rs::GitHubRepoResponse` 增加 `#[serde(default)] pub pushed_at: Option<String>` 与 `#[serde(default)] pub updated_at: Option<String>`；
   - 解析个人/Fork 仓库信号时，`UserRepoSignal.updated_at` 优先取 `pushed_at`，其次 `updated_at`，均缺失时回退按全局序号递减 `now.saturating_sub((global_idx as i64) * 3600)`。
3. **`RawAffinitySignals` 补充未收录应用轻量详情摘要**：
   - 在 `src-tauri/src/db/affinity.rs` 定义 `UncatalogedSignalBrief { pub name: String, pub owner: String, pub repo: String, pub description: String, pub description_en: Option<String>, pub category: String }`，并在 `RawAffinitySignals` 新增 `pub uncataloged_briefs: HashMap<String, UncatalogedSignalBrief>`（`Default` 为空 Map，不影响现有 `..Default::default()` 构造）；
   - `Database::load_raw_affinity_signals` 收集 `favorites`、`watched`、`installed`、`views` 去重后的小写 `app_id` 集合，通过单条批量 SQL（或限定最多 200 个去重 id 的 `IN` 子句）从 `app_details` 读取上述轻量列（不反序列化大体积 `readme_markdown` 与 `releases_json`）；
   - 对命中 `crate::github::detail_fetch::is_placeholder_description` 的占位简介置空，键统一归一为小写 `app_id`。

## 范围（互斥）

- 允许修改：`src-tauri/src/db/affinity.rs`、`src-tauri/src/github/models.rs`、`src-tauri/src/github/affinity.rs`（仅限第 `1..=412` 行同步/分页解析区及其对应同步单测）。
- 禁止触碰：`src-tauri/src/github/affinity.rs` 中 `UserAffinityProfile` 画像打分逻辑、`src-tauri/src/github/featured.rs`、`src-tauri/src/commands/*`、`src/*`。

## 验收标准

- [ ] 单测：模拟返回 `application/vnd.github.star+json` 格式（含不同 `starred_at`）时，落库的 `UserRepoSignal.updated_at` 精确等于对应 RFC3339 时间戳秒数，且请求头 `Accept` 为 `application/vnd.github.star+json`。
- [ ] 单测：旧格式裸仓库数组（无 `starred_at`）分页解析依然成功，且第 1 条与第 2 条信号的 `updated_at` 严格保持先后顺序（`sig[0].updated_at > sig[1].updated_at`）。
- [ ] 单测：当 `api_etag_cache` 存有不含 `starred_at` 的旧缓存时，同步请求不携带旧 `If-None-Match`，成功升级为含 `starred_at` 的新载荷。
- [ ] 单测：`app_details` 存有未收录应用详情且被加入收藏/浏览后，`load_raw_affinity_signals().uncataloged_briefs` 包含对应概要，占位简介已被过滤为空串。
- [ ] 既有 `db::affinity` 与 `github::affinity` 同步单测全部通过：`cargo test --manifest-path src-tauri/Cargo.toml --lib`。

## Comments

- 范围外的测试改动：`developer_starred.rs` 的测试 mock 增加 `seen_accept` 记录请求 `Accept` 头（验收项要求断言请求头）；`detail_fetch.rs` 测试夹具补 `pushed_at` / `updated_at` 两个新字段才能编译。均不涉及生产逻辑。
- 旧格式升级只做一次：新增设置项 `affinity_starred_format_upgraded`，Star 列表成功同步一次后不再因缓存缺 `starred_at` 跳过 `If-None-Match`，避免服务端持续返回裸格式时每次都整页重拉。
- 概要读取不设总量上限，改为每批 200 个 id；`app_details.app_id` 写入时不统一大小写，查询按 `LOWER(app_id)` 比对（表经 `prune_app_details` 限行，全表扫描可接受）。
