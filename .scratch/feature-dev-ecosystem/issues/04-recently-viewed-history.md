# Issue 04: 最近浏览历史与搜索词本地持久化

Status: resolved

## 描述

实现用户搜索历史与最近浏览应用的本地持久化与智能推荐交互：
1. 本地数据库扩展：
   - `search_history`: 字段 `query TEXT UNIQUE NOT NULL`, `searched_at INTEGER NOT NULL`；
   - `view_history`: 字段 `app_id TEXT UNIQUE NOT NULL`, `viewed_at INTEGER NOT NULL`；
   - 在 `db.rs` 中提供滑动窗口记录（搜索词限 20 条，浏览记录限 30 条）、按时间倒序查询、单条删除与全部清空能力。
2. Tauri IPC 命令：
   - `record_search_query(query: String) -> Result<(), String>`
   - `get_search_history() -> Result<Vec<String>, String>`
   - `clear_search_history() -> Result<(), String>`
   - `record_app_view(app_id: String) -> Result<(), String>`
   - `get_recently_viewed_apps() -> Result<Vec<AppSummary>, String>`
   - `clear_view_history() -> Result<(), String>`
3. 前端交互落地：
   - 搜索框（`TitleBar.tsx`）在聚焦时弹出 Fluent 历史搜索推荐气泡，支持点击回填立即搜索与单键清除；
   - 探索中心首页（`HomeView.tsx`）增加「🕒 最近浏览」快捷专区，展示近期查看过的软件卡片，方便快速回访；
   - 在用户点击应用详情弹窗时自动触发 `record_app_view`。
4. 单元测试覆盖 CRUD 与滑动窗口去重截断逻辑。

## Comments

- 严格保障用户隐私，所有历史记录 100% 保存在本地 SQLite 数据库中，不上传至任何远端服务器。

## Answer

已完成搜索历史与最近浏览足迹本地持久化与交互闭环：
1. 在 SQLite `db.rs` 中新建 `search_history` 与 `view_history` 表，实现了带上限自动截断（搜索限 20 条、浏览限 30 条）的 Upsert CRUD 与清除方法；
2. 在 `commands.rs` 中新增 7 个 IPC 命令并在 `lib.rs` 中注册；
3. 在 `TitleBar.tsx` 中新增聚焦下拉历史气泡，支持点击回填、单条删除与一键清空；
4. 在 `HomeView.tsx` 中新增「🕒 最近浏览」快捷专区，与应用详情打开事件自动联动；
5. 单元测试 `test_search_and_view_history_crud` 已全量验证通过。

