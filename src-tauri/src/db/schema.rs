use super::Database;
use rusqlite::Result;

/// 当前 schema 版本（`PRAGMA user_version`）。
/// 破坏性迁移在 `run_migrations` 的 match 迁移链中按版本推进，已发布版本语义不可更改。
const CURRENT_USER_VERSION: i64 = 9;

/// 判定历史 `["windows"]` 记录是否属于 macOS 包体错判（`app_details` 缓存含 `.app.zip`/`.app.tar.*` 等 macOS 资产，
/// 或 `identifiers` 明确配置了 `macos` 标识且无 `windows` 标识），命中则就地纠正 `platforms`。
fn heal_poisoned_mac_platforms(
    conn: &rusqlite::Connection,
    id: &str,
    platforms: &mut Vec<String>,
    identifiers: &std::collections::HashMap<String, Vec<String>>,
) -> bool {
    if !(platforms.len() == 1 && platforms[0].eq_ignore_ascii_case("windows")) {
        return false;
    }

    let releases_json: Option<String> = conn
        .query_row(
            "SELECT releases_json FROM app_details WHERE LOWER(app_id) = LOWER(?1) LIMIT 1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .ok();
    if let Some(raw_releases) = releases_json {
        if let Ok(mut releases) =
            serde_json::from_str::<Vec<crate::models::ReleaseAsset>>(&raw_releases)
        {
            if !releases.is_empty() {
                releases.retain(|r| {
                    crate::github::detail_assets::is_valid_installer_asset(&r.name, r.size_bytes)
                });
                crate::github::detail_assets::refresh_release_assets_classification(&mut releases);
                let deduced = crate::github::detail_assets::platforms_from_assets(&releases);
                let has_mac = deduced.iter().any(|p| p.eq_ignore_ascii_case("macos"));
                let has_win = deduced.iter().any(|p| p.eq_ignore_ascii_case("windows"));
                if has_mac && !has_win {
                    *platforms = deduced;
                    return true;
                }
            }
        }
    }

    let has_mac_id = identifiers.get("macos").is_some_and(|v| !v.is_empty());
    let has_win_id = identifiers.get("windows").is_some_and(|v| !v.is_empty());
    if has_mac_id && !has_win_id {
        *platforms = vec!["macos".to_string()];
        return true;
    }
    false
}

impl Database {
    pub(crate) fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS installed_apps (
                app_id TEXT PRIMARY KEY,
                app_name TEXT NOT NULL,
                version TEXT NOT NULL,
                installed_at INTEGER NOT NULL,
                install_method TEXT NOT NULL,
                install_path TEXT NOT NULL,
                asset_name TEXT NOT NULL,
                asset_sha256 TEXT NOT NULL,
                uninstall_command TEXT
            );

            CREATE TABLE IF NOT EXISTS api_etag_cache (
                endpoint_url TEXT PRIMARY KEY,
                etag TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                last_checked_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS catalog_apps (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                description_en TEXT,
                category TEXT NOT NULL,
                category_name TEXT NOT NULL,
                aliases_json TEXT NOT NULL DEFAULT '[]',
                default_version TEXT NOT NULL DEFAULT '',
                added_at TEXT,
                license TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                is_verified INTEGER NOT NULL DEFAULT 0,
                homepage TEXT,
                platforms_json TEXT NOT NULL DEFAULT '[]',
                identifiers_json TEXT NOT NULL DEFAULT '{}',
                install_dirs_json TEXT NOT NULL DEFAULT '[]',
                search_subdirs_json TEXT NOT NULL DEFAULT '[]',
                publishers_json TEXT NOT NULL DEFAULT '[]',
                forge TEXT NOT NULL DEFAULT 'github',
                forge_host TEXT NOT NULL DEFAULT 'github.com',
                manifest_synced_at INTEGER NOT NULL DEFAULT 0,
                detail_synced_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_catalog_apps_category ON catalog_apps(category);
            CREATE INDEX IF NOT EXISTS idx_catalog_apps_stars ON catalog_apps(stars DESC);
            CREATE INDEX IF NOT EXISTS idx_catalog_apps_added_at ON catalog_apps(added_at DESC, stars DESC);
            CREATE INDEX IF NOT EXISTS idx_catalog_apps_owner_repo ON catalog_apps(owner, repo);

            CREATE TABLE IF NOT EXISTS app_details (
                app_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                description_en TEXT,
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                license TEXT NOT NULL DEFAULT '',
                latest_version TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'external',
                category_name TEXT NOT NULL DEFAULT '跨平台开源',
                forge TEXT NOT NULL DEFAULT 'github',
                forge_host TEXT NOT NULL DEFAULT 'github.com',
                homepage TEXT,
                platforms_json TEXT NOT NULL DEFAULT '[]',
                changelog TEXT NOT NULL DEFAULT '',
                readme_markdown TEXT NOT NULL DEFAULT '',
                readme_variants_json TEXT,
                releases_json TEXT NOT NULL DEFAULT '[]',
                cached_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_app_details_cached_at ON app_details(cached_at DESC);

            CREATE TABLE IF NOT EXISTS user_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_favorites (
                app_id TEXT PRIMARY KEY,
                favorited_at INTEGER NOT NULL,
                is_cataloged INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS update_rules (
                app_id TEXT PRIMARY KEY,
                skipped_version TEXT,
                is_frozen INTEGER NOT NULL DEFAULT 0,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query TEXT UNIQUE NOT NULL,
                searched_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS view_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_id TEXT NOT NULL,
                viewed_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_view_history_app_viewed ON view_history(app_id, viewed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_view_history_viewed_at ON view_history(viewed_at DESC);

            CREATE TABLE IF NOT EXISTS host_tokens (
                host TEXT PRIMARY KEY,
                token TEXT NOT NULL,
                rate_limit_remaining INTEGER,
                rate_limit_limit INTEGER,
                rate_limit_reset INTEGER,
                updated_at INTEGER NOT NULL
            );

            -- ADR-0007 默认挡位：应用详情缓存保鲜期 60 分钟（仅缺失时填充，不覆盖用户已存值）
            INSERT OR IGNORE INTO user_settings (key, value) VALUES ('detail_cache_ttl_minutes', '60');

            -- 关注订阅表：daily 频率下 last_notified_at 保证每应用每天至多通知一次；
            -- dismissed_version/dismissed_at 记录用户已确认的提醒版本与确认时间，
            -- dismissed_version 与 last_notified_version 不同即为待处理提醒
            CREATE TABLE IF NOT EXISTS watched_apps (
                app_id TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL,
                last_notified_version TEXT,
                last_notified_at INTEGER,
                is_cataloged INTEGER NOT NULL DEFAULT 0,
                dismissed_version TEXT,
                dismissed_at INTEGER
            );

            -- GitHub Star 列表本地持久化记录
            CREATE TABLE IF NOT EXISTS user_stars (
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                starred_at INTEGER NOT NULL,
                PRIMARY KEY (owner, repo)
            );

            -- 图标缓存来源与有效性追踪表
            CREATE TABLE IF NOT EXISTS icon_cache_meta (
                cache_key TEXT PRIMARY KEY,
                remote_url TEXT NOT NULL,
                cached_at INTEGER NOT NULL
            );

            -- 刷新图标轮换状态追踪表
            CREATE TABLE IF NOT EXISTS app_icon_cycles (
                app_id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                is_cataloged INTEGER NOT NULL DEFAULT 0,
                level INTEGER NOT NULL DEFAULT 1,
                l1_url TEXT NOT NULL DEFAULT '',
                l2_url TEXT NOT NULL DEFAULT '',
                l3_url TEXT NOT NULL DEFAULT '',
                l4_url TEXT NOT NULL DEFAULT '',
                selected_url TEXT NOT NULL DEFAULT '',
                cache_file TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_icon_cycles_owner_repo ON app_icon_cycles(owner, repo);

            -- 默认关注通知频率：daily（仅缺失时填充）
            INSERT OR IGNORE INTO user_settings (key, value) VALUES ('watch_notify_frequency', 'daily');

            -- 趋势榜缓存（纯透存，后端不判 TTL；board 列供双档清扫区分 daily/其余）
            CREATE TABLE IF NOT EXISTS trend_board_cache (
                cache_key TEXT PRIMARY KEY,
                board TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER DEFAULT 0,
                cached_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_trend_board_cache_board ON trend_board_cache(board);

            CREATE INDEX IF NOT EXISTS idx_trend_board_cache_cached_at ON trend_board_cache(cached_at DESC);

            -- Star 同步快照（纯透存，前端判新鲜度；owner_scope 以 `@me:` 开头的为账号私有，登出即清）
            CREATE TABLE IF NOT EXISTS starred_feed_cache (
                cache_key TEXT PRIMARY KEY,
                owner_scope TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL DEFAULT 0,
                cached_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_starred_feed_cache_cached_at ON starred_feed_cache(cached_at DESC);

            -- 未收录应用单仓轻量富卡（ADR-0027）：与 catalog_apps / custom_apps 物理隔离，
            -- 不含收录态标注与 data: 图标；updated_at = 0 为平台预写壳（批量水合不可见）；
            -- is_private = 1 随登出清除；按 last_accessed_at 有界 LRU。
            CREATE TABLE IF NOT EXISTS repo_card_cache (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                description_en TEXT,
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                license TEXT NOT NULL DEFAULT '',
                latest_version TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'external',
                category_name TEXT NOT NULL DEFAULT '跨平台开源',
                forge TEXT NOT NULL DEFAULT 'github',
                forge_host TEXT NOT NULL DEFAULT 'github.com',
                homepage TEXT,
                platforms_json TEXT NOT NULL DEFAULT '[]',
                confirmed_other INTEGER NOT NULL DEFAULT 0,
                is_private INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                last_accessed_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_repo_card_cache_lru ON repo_card_cache(last_accessed_at ASC);

            CREATE INDEX IF NOT EXISTS idx_repo_card_cache_private ON repo_card_cache(is_private) WHERE is_private = 1;

            -- 在线搜索分页有序 id 索引快照（v: 2，纯透存，前端判新鲜度；has_private = 1 随登出清除）
            CREATE TABLE IF NOT EXISTS search_list_cache (
                cache_key TEXT PRIMARY KEY,
                norm_query TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL DEFAULT 0,
                has_private INTEGER NOT NULL DEFAULT 0,
                cached_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_search_list_cache_cached_at ON search_list_cache(cached_at DESC);

            CREATE INDEX IF NOT EXISTS idx_search_list_cache_query ON search_list_cache(norm_query);

            -- 开源广场静态清单二级快照（与 catalog_apps / custom_apps 物理隔离，见 ADR-0029）
            CREATE TABLE IF NOT EXISTS launchpad_feed_cache (
                source_url TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL DEFAULT 0,
                cached_at INTEGER NOT NULL
            );

            -- 开源广场讨论与脉冲状态缓存（承接实时 Discussions 计数、本人顶帖态与源仓星数，跨重启保留；登出清除 viewer_has_upvoted）
            CREATE TABLE IF NOT EXISTS launchpad_discussion_cache (
                discussion_repo TEXT NOT NULL,
                discussion_number INTEGER NOT NULL,
                node_id TEXT NOT NULL DEFAULT '',
                upvote_count INTEGER NOT NULL DEFAULT 0,
                comments_count INTEGER NOT NULL DEFAULT 0,
                viewer_has_upvoted INTEGER,
                stars INTEGER,
                forks INTEGER,
                latest_version TEXT,
                synced_at INTEGER NOT NULL,
                repo_synced_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (discussion_repo, discussion_number)
            );

            CREATE INDEX IF NOT EXISTS idx_launchpad_discussion_synced_at ON launchpad_discussion_cache(synced_at DESC);

            CREATE TABLE IF NOT EXISTS asset_cache (
                url TEXT PRIMARY KEY,
                hash TEXT NOT NULL,
                local_path TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                etag TEXT,
                last_modified TEXT,
                last_used INTEGER NOT NULL,
                expires_at INTEGER NOT NULL DEFAULT 0,
                hits INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_asset_cache_last_used ON asset_cache(last_used);

            CREATE INDEX IF NOT EXISTS idx_asset_cache_expires_at ON asset_cache(expires_at);

            CREATE INDEX IF NOT EXISTS idx_asset_cache_hash ON asset_cache(hash);

            CREATE TABLE IF NOT EXISTS asset_refs (
                hash TEXT NOT NULL,
                app_id TEXT NOT NULL,
                last_seen INTEGER NOT NULL,
                PRIMARY KEY (hash, app_id)
            );

            -- 本地自维护条目 overlay：草稿暂存 + 本地收录（ADR-0017）。
            -- id 为 canonical 小写形态（仅 GitHub `owner/repo`）；
            -- payload_json 存完整 CatalogItem；status=draft/submitted/collected
            --（已提交另存 pr_url；collected 为本地收录态，可搜可装）；
            -- `local_collected` 与 `collected` 为存储同义值，查询统一兼容匹配；
            -- archived=1 为转正（远端已收录）自动归档标记。
            CREATE TABLE IF NOT EXISTS custom_apps (
                id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                pr_url TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_custom_apps_archived ON custom_apps(archived);

            CREATE INDEX IF NOT EXISTS idx_custom_apps_status ON custom_apps(status);

            -- 更新中心持久化（update-results cache）：一次手动刷新对每个已安装应用的判定快照。
            -- has_update=1 行即 UpdatesView 列表；installed_version 供读取时与当前安装版本比对过期；
            -- changelog/icon/icon_bg 透存远端回包，get_cached_updates 零网络直显。
            CREATE TABLE IF NOT EXISTS update_results (
                app_id TEXT PRIMARY KEY,
                app_name TEXT NOT NULL,
                installed_version TEXT NOT NULL,
                latest_version TEXT NOT NULL,
                has_update INTEGER NOT NULL DEFAULT 0,
                changelog TEXT NOT NULL DEFAULT '',
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                checked_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_update_results_has_update ON update_results(has_update);

            -- 本地亲和度推荐：用户 GitHub Star / Fork / 自有仓库特征信号表
            CREATE TABLE IF NOT EXISTS user_repo_signals (
                full_name TEXT NOT NULL,
                relation TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (full_name, relation)
            );

            CREATE INDEX IF NOT EXISTS idx_user_repo_signals_updated_at ON user_repo_signals(updated_at);

            -- 精选页冷启动：用户显式选择的兴趣分类（ADR-0023）
            CREATE TABLE IF NOT EXISTS user_interest_seeds (
                category TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );

            -- 精选页推荐负反馈：scope = 'app'（target 为规范应用标识）| 'category'（target 为分类 key）
            CREATE TABLE IF NOT EXISTS user_feed_feedback (
                target TEXT NOT NULL,
                scope TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (target, scope)
            );
            "#,
        )?;
        // 幂等补列：缺列时执行 `ADD COLUMN` 补齐 `is_cataloged`（默认 0 fail-closed，启动回填按目录校准），
        // 列存在即跳过，保证任意版本启动均可自愈。
        self.ensure_column(
            "user_favorites",
            "is_cataloged",
            "ALTER TABLE user_favorites ADD COLUMN is_cataloged INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "watched_apps",
            "is_cataloged",
            "ALTER TABLE watched_apps ADD COLUMN is_cataloged INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "watched_apps",
            "dismissed_version",
            "ALTER TABLE watched_apps ADD COLUMN dismissed_version TEXT",
        )?;
        self.ensure_column(
            "watched_apps",
            "dismissed_at",
            "ALTER TABLE watched_apps ADD COLUMN dismissed_at INTEGER",
        )?;
        self.run_migrations()
    }

    /// user_version 迁移链：读取当前版本并逐版执行迁移函数，完成后写入 `CURRENT_USER_VERSION`。
    /// 基底 DDL 与幂等补列先行执行；高版本库被低版本打开时不降级版本号、不执行迁移链，仅执行幂等基底 DDL 自愈。
    fn run_migrations(&self) -> Result<()> {
        let version = self.user_version()?;
        if version > CURRENT_USER_VERSION {
            log::warn!(
                target: "app",
                "db user_version={} > supported={} (skipping migrations)",
                version,
                CURRENT_USER_VERSION
            );
            return Ok(());
        }
        for v in version..CURRENT_USER_VERSION {
            match v {
                0 => self.migrate_v0_to_v1()?,
                1 => self.migrate_v1_to_v2()?,
                2 => self.migrate_v2_to_v3()?,
                3 => self.migrate_v3_to_v4()?,
                4 => self.migrate_v4_to_v5()?,
                5 => self.migrate_v5_to_v6()?,
                6 => self.migrate_v6_to_v7()?,
                7 => self.migrate_v7_to_v8()?,
                8 => self.migrate_v8_to_v9()?,
                other => {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                        Some(format!(
                            "迁移链存在空洞：v{other} 无对应迁移函数（user_version={version}, CURRENT_USER_VERSION={CURRENT_USER_VERSION}），请补齐 migrate_v{other}_to_v{}",
                            other + 1
                        )),
                    ));
                }
            }
        }
        if version < CURRENT_USER_VERSION {
            self.set_user_version(CURRENT_USER_VERSION)?;
        }
        Ok(())
    }

    /// v0 → v1 基线版本标记迁移。
    fn migrate_v0_to_v1(&self) -> Result<()> {
        Ok(())
    }

    /// v1 → v2：直接切换至 `catalog_apps` + `app_details` 双表体系，清理旧 `app_details_cache`。
    fn migrate_v1_to_v2(&self) -> Result<()> {
        self.conn
            .execute_batch("DROP TABLE IF EXISTS app_details_cache;")?;
        Ok(())
    }

    /// v2 → v3：解除 `view_history.app_id` 的 UNIQUE 约束，改为事件流水表并补齐索引。
    fn migrate_v2_to_v3(&self) -> Result<()> {
        self.with_immediate_transaction(|| {
            self.conn.execute_batch(
                r#"
                CREATE TABLE view_history_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    app_id TEXT NOT NULL,
                    viewed_at INTEGER NOT NULL
                );
                INSERT INTO view_history_new (id, app_id, viewed_at)
                SELECT id, app_id, viewed_at FROM view_history ORDER BY id ASC;
                DROP TABLE view_history;
                ALTER TABLE view_history_new RENAME TO view_history;
                CREATE INDEX IF NOT EXISTS idx_view_history_app_viewed ON view_history(app_id, viewed_at DESC);
                CREATE INDEX IF NOT EXISTS idx_view_history_viewed_at ON view_history(viewed_at DESC);
                "#,
            )
        })
    }

    /// v3 → v4：`update_rules` 收敛为「锁定包含跳过」——清掉已锁定规则上的跳过版本，
    /// 并删除不含任何策略的空规则行。
    fn migrate_v3_to_v4(&self) -> Result<()> {
        self.conn.execute_batch(
            "UPDATE update_rules SET skipped_version = NULL WHERE is_frozen = 1;
             DELETE FROM update_rules
             WHERE (skipped_version IS NULL OR TRIM(skipped_version) = '')
               AND is_frozen = 0 AND is_hidden = 0;",
        )
    }

    /// v4 → v5：个性化推荐拆成本地应用信息（`enable_local_affinity`）与 GitHub 用户信息
    /// （`enable_github_affinity`）两个信号源开关；GitHub 开关继承原总开关的值，
    /// 关闭过个性化推荐的用户升级后仍保持关闭。
    fn migrate_v4_to_v5(&self) -> Result<()> {
        self.conn.execute_batch(
            "INSERT OR IGNORE INTO user_settings (key, value)
             SELECT 'enable_github_affinity', value FROM user_settings
             WHERE key = 'enable_local_affinity';",
        )
    }

    /// v5 → v6：趋势榜与 Star 列表快照改为 `v: 2` 瘦 id 索引，旧 `v: 1` 富信封整表清除。
    fn migrate_v5_to_v6(&self) -> Result<()> {
        self.conn.execute_batch(
            "DELETE FROM trend_board_cache;
             DELETE FROM starred_feed_cache;",
        )
    }

    /// v7 → v8：开源广场清单独立快照表 `launchpad_feed_cache`（幂等建表，基底 DDL 已同步声明）。
    fn migrate_v7_to_v8(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS launchpad_feed_cache (
                source_url TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL DEFAULT 0,
                cached_at INTEGER NOT NULL
            );",
        )
    }

    /// v8 → v9：开源广场讨论与卡片脉冲持久化表 `launchpad_discussion_cache`（幂等建表，基底 DDL 已同步声明）。
    fn migrate_v8_to_v9(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS launchpad_discussion_cache (
                discussion_repo TEXT NOT NULL,
                discussion_number INTEGER NOT NULL,
                node_id TEXT NOT NULL DEFAULT '',
                upvote_count INTEGER NOT NULL DEFAULT 0,
                comments_count INTEGER NOT NULL DEFAULT 0,
                viewer_has_upvoted INTEGER,
                stars INTEGER,
                forks INTEGER,
                latest_version TEXT,
                synced_at INTEGER NOT NULL,
                repo_synced_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (discussion_repo, discussion_number)
            );
            CREATE INDEX IF NOT EXISTS idx_launchpad_discussion_synced_at ON launchpad_discussion_cache(synced_at DESC);",
        )?;
        let has_repo_synced: bool = self
            .conn
            .prepare("SELECT 1 FROM pragma_table_info('launchpad_discussion_cache') WHERE name = 'repo_synced_at'")?
            .exists([])?;
        if !has_repo_synced {
            self.conn.execute(
                "ALTER TABLE launchpad_discussion_cache ADD COLUMN repo_synced_at INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(())
    }

    /// v6 → v7：校正老版本误回写的 `catalog_apps` 与 `custom_apps` 平台历史错账（如 `Maccy` 被写成 `["windows"]`），
    /// 并清除清单同步 ETag/周期缓存以便下次联网全量重对齐远端清单。
    fn migrate_v6_to_v7(&self) -> Result<()> {
        let has_catalog: bool = self
            .query_scalar_opt("SELECT 1 FROM catalog_apps LIMIT 1", [])?
            .unwrap_or(false);
        let has_custom: bool = self
            .query_scalar_opt("SELECT 1 FROM custom_apps LIMIT 1", [])?
            .unwrap_or(false);
        if !has_catalog && !has_custom {
            return Ok(());
        }

        self.with_immediate_transaction(|| {
            if has_catalog {
                let seed_items: Vec<crate::github::models::CatalogItem> =
                    serde_json::from_str(crate::config::embedded_catalog_json())
                        .unwrap_or_default();
                let seed_platforms: std::collections::HashMap<String, Vec<String>> = seed_items
                    .into_iter()
                    .filter(|item| !item.platforms.is_empty())
                    .map(|item| (item.id.to_lowercase(), item.platforms))
                    .collect();

                let mut stmt = self.conn.prepare(
                    "SELECT id, platforms_json, identifiers_json FROM catalog_apps",
                )?;
                let rows: Vec<(String, String, String)> = stmt
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<Result<Vec<_>>>()?;
                drop(stmt);

                for (id, platforms_json, identifiers_json) in rows {
                    if let Some(seed_plats) = seed_platforms.get(&id.to_lowercase()) {
                        let seed_json =
                            serde_json::to_string(seed_plats).unwrap_or_else(|_| "[]".into());
                        if platforms_json != seed_json {
                            self.conn.execute(
                                "UPDATE catalog_apps SET platforms_json = ?1 WHERE id = ?2",
                                rusqlite::params![seed_json, id],
                            )?;
                        }
                        continue;
                    }
                    let mut platforms: Vec<String> =
                        serde_json::from_str(&platforms_json).unwrap_or_default();
                    let identifiers: std::collections::HashMap<String, Vec<String>> =
                        serde_json::from_str(&identifiers_json).unwrap_or_default();
                    if heal_poisoned_mac_platforms(
                        &self.conn,
                        &id,
                        &mut platforms,
                        &identifiers,
                    ) {
                        let healed_json =
                            serde_json::to_string(&platforms).unwrap_or_else(|_| "[]".into());
                        self.conn.execute(
                            "UPDATE catalog_apps SET platforms_json = ?1 WHERE id = ?2",
                            rusqlite::params![healed_json, id],
                        )?;
                    }
                }

                // 重置清单同步周期与 catalog.json ETag，避免升级后一直命中 304 无法拉取远端最新精校字段
                let mut urls_to_clear: Vec<String> = vec![
                    crate::config::CatalogConfig::default().default_source_url,
                ];
                for key in ["catalog_last_synced_url", "catalog_source_url"] {
                    if let Some(u) = self
                        .query_scalar_opt::<String, _>(
                            "SELECT value FROM user_settings WHERE key = ?1",
                            rusqlite::params![key],
                        )?
                        .filter(|s| !s.trim().is_empty())
                    {
                        urls_to_clear.push(u);
                    }
                }
                for u in urls_to_clear {
                    self.conn.execute(
                        "DELETE FROM api_etag_cache WHERE endpoint_url = ?1",
                        rusqlite::params![u],
                    )?;
                }
                self.conn.execute(
                    "DELETE FROM api_etag_cache WHERE endpoint_url LIKE '%/catalog.json'",
                    [],
                )?;
                self.conn.execute(
                    "DELETE FROM user_settings WHERE key IN ('catalog_last_synced_day', 'catalog_last_synced_url')",
                    [],
                )?;
            }

            if has_custom {
                let mut stmt = self
                    .conn
                    .prepare("SELECT id, payload_json FROM custom_apps")?;
                let rows: Vec<(String, String)> = stmt
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<Vec<_>>>()?;
                drop(stmt);

                for (id, payload_json) in rows {
                    let Ok(mut item) =
                        serde_json::from_str::<crate::github::models::CatalogItem>(&payload_json)
                    else {
                        continue;
                    };
                    if heal_poisoned_mac_platforms(
                        &self.conn,
                        &id,
                        &mut item.platforms,
                        &item.identifiers,
                    ) {
                        item.added_at = None;
                        if let Ok(healed_payload) = serde_json::to_string(&item) {
                            self.conn.execute(
                                "UPDATE custom_apps SET payload_json = ?1 WHERE id = ?2",
                                rusqlite::params![healed_payload, id],
                            )?;
                        }
                    }
                }
            }

            Ok(())
        })
    }

    /// 读 `PRAGMA user_version`（迁移链与 schema 迁移测试共用读口）。
    pub(crate) fn user_version(&self) -> Result<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
    }

    /// 盖章 user_version（值为内部版本常量，无外部输入拼接面）。
    fn set_user_version(&self, v: i64) -> Result<()> {
        self.conn
            .execute_batch(&format!("PRAGMA user_version = {v};"))
    }

    /// 轻量列迁移：缺列时执行 `ADD COLUMN`，列存在即跳过。
    /// `table`/`column`/`ddl` 均为内部常量，不拼接外部输入。
    fn ensure_column(&self, table: &str, column: &str, ddl: &str) -> Result<()> {
        let exists: bool = self
            .query_scalar_opt(
                "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2",
                rusqlite::params![table, column],
            )?
            .unwrap_or(false);
        if !exists {
            self.conn.execute(ddl, [])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod schema_migration_tests {
    use super::{Database, CURRENT_USER_VERSION};

    #[test]
    fn fresh_db_stamps_user_version_and_reinit_is_idempotent() {
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        assert_eq!(
            db.user_version().unwrap(),
            CURRENT_USER_VERSION,
            "新库经 init_schema 应当盖章至当前版本"
        );
        // 重复 init：版本号保持不变，不重跑已完成迁移
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);
    }

    #[test]
    fn legacy_v0_db_upgrades_column_and_stamps_version() {
        // 构造缺收录标记列且 user_version = 0 的数据库形态
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE user_favorites (
                app_id TEXT PRIMARY KEY,
                favorited_at INTEGER NOT NULL
            );
            INSERT INTO user_favorites (app_id, favorited_at) VALUES ('rustdesk/rustdesk', 1700000000);
            "#,
        )
        .unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();

        assert_eq!(
            db.user_version().unwrap(),
            CURRENT_USER_VERSION,
            "v0 数据库应当执行 v0→v1 迁移并写入当前版本号"
        );
        let has_col: bool = db
            .query_scalar_opt(
                "SELECT 1 FROM pragma_table_info('user_favorites') WHERE name = 'is_cataloged'",
                [],
            )
            .unwrap()
            .unwrap_or(false);
        assert!(has_col, "缺列应当被幂等补齐");
        // 未标注行默认收录标记为 0（fail-closed）
        let entries = db.get_favorite_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].app_id, "rustdesk/rustdesk");
        assert!(!entries[0].is_cataloged, "未标注行收录标记应当默认 0");
    }

    #[test]
    fn higher_version_db_stays_readonly_without_downgrade_stamp() {
        // 高版本数据库不降级 user_version、不跑迁移链，幂等基底 DDL 仍执行（缺表/缺列自愈）。
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), 99, "高版本库不得被降级盖章");
        // 幂等基底照常执行：新表可建、查询可用。
        let tables: i64 = db
            .query_scalar_opt(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('update_results', 'catalog_apps', 'app_details')",
                [],
            )
            .unwrap()
            .unwrap_or(0);
        assert_eq!(tables, 3, "幂等基底在高版本库上仍应补齐表结构");
    }

    #[test]
    fn v5_db_purges_fat_list_snapshots_and_creates_card_tables() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE trend_board_cache (
                cache_key TEXT PRIMARY KEY,
                board TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER DEFAULT 0,
                cached_at INTEGER
            );
            CREATE TABLE starred_feed_cache (
                cache_key TEXT PRIMARY KEY,
                owner_scope TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL DEFAULT 0,
                cached_at INTEGER NOT NULL
            );
            INSERT INTO trend_board_cache VALUES ('daily||', 'daily', '{"v":1,"repos":[]}', 10, 1);
            INSERT INTO starred_feed_cache VALUES ('@me:x', '@me:x', '{"v":1,"rows":[]}', 10, 1);
            PRAGMA user_version = 5;
            "#,
        )
        .unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);
        let count = |sql: &str| -> i64 { db.query_scalar_opt(sql, []).unwrap().unwrap_or(-1) };
        assert_eq!(count("SELECT COUNT(*) FROM trend_board_cache"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM starred_feed_cache"), 0);
        assert_eq!(
            count("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('repo_card_cache', 'search_list_cache')"),
            2
        );
    }

    #[test]
    fn v4_db_github_affinity_switch_inherits_disabled_personalization() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO user_settings VALUES ('enable_local_affinity', 'false');
            PRAGMA user_version = 4;
            "#,
        )
        .unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);
        assert_eq!(
            db.get_setting("enable_github_affinity").unwrap().as_deref(),
            Some("false")
        );
    }

    #[test]
    fn v3_db_migrates_update_rules_so_lock_supersedes_skip() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE update_rules (
                app_id TEXT PRIMARY KEY,
                skipped_version TEXT,
                is_frozen INTEGER NOT NULL DEFAULT 0,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO update_rules VALUES ('yetone/magpie', 'v1', 1, 1, 1);
            INSERT INTO update_rules VALUES ('wezterm/wezterm', 'v2', 0, 0, 1);
            INSERT INTO update_rules VALUES ('obsproject/obs-studio', NULL, 0, 0, 1);
            PRAGMA user_version = 3;
            "#,
        )
        .unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);

        let magpie = db.get_rule("yetone/magpie").unwrap().unwrap();
        assert!(magpie.is_frozen && magpie.is_hidden);
        assert_eq!(magpie.skipped_version, None);
        let wezterm = db.get_rule("wezterm/wezterm").unwrap().unwrap();
        assert_eq!(wezterm.skipped_version.as_deref(), Some("v2"));
        assert!(db.get_rule("obsproject/obs-studio").unwrap().is_none());
    }

    #[test]
    fn v2_db_migrates_view_history_without_unique_constraint_and_preserves_rows() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE view_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_id TEXT UNIQUE NOT NULL,
                viewed_at INTEGER NOT NULL
            );
            INSERT INTO view_history (id, app_id, viewed_at) VALUES (221, 'acme/alpha', 1700000100);
            INSERT INTO view_history (id, app_id, viewed_at) VALUES (239, 'acme/beta', 1700000200);
            PRAGMA user_version = 2;
            "#,
        )
        .unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);

        // 迁移后可写入同 app_id 的多条浏览事件且旧数据完整保留
        assert!(db.record_app_view_at("acme/alpha", 1700000300).unwrap());
        let rows: i64 = db
            .query_scalar_opt("SELECT COUNT(*) FROM view_history", [])
            .unwrap()
            .unwrap_or(0);
        assert_eq!(rows, 3);
        let ids = db.get_recently_viewed_app_ids().unwrap();
        assert_eq!(ids, vec!["acme/alpha", "acme/beta"]);
    }

    #[test]
    fn v6_db_heals_poisoned_catalog_and_custom_apps_maccy_platforms() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE catalog_apps (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                description_en TEXT,
                category TEXT NOT NULL,
                category_name TEXT NOT NULL,
                aliases_json TEXT NOT NULL DEFAULT '[]',
                default_version TEXT NOT NULL DEFAULT '',
                added_at TEXT,
                license TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                is_verified INTEGER NOT NULL DEFAULT 0,
                homepage TEXT,
                platforms_json TEXT NOT NULL DEFAULT '[]',
                identifiers_json TEXT NOT NULL DEFAULT '{}',
                install_dirs_json TEXT NOT NULL DEFAULT '[]',
                search_subdirs_json TEXT NOT NULL DEFAULT '[]',
                publishers_json TEXT NOT NULL DEFAULT '[]',
                forge TEXT NOT NULL DEFAULT 'github',
                forge_host TEXT NOT NULL DEFAULT 'github.com',
                manifest_synced_at INTEGER NOT NULL DEFAULT 0,
                detail_synced_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE custom_apps (
                id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                pr_url TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE app_details (
                app_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                description_en TEXT,
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                license TEXT NOT NULL DEFAULT '',
                latest_version TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'external',
                category_name TEXT NOT NULL DEFAULT '跨平台开源',
                forge TEXT NOT NULL DEFAULT 'github',
                forge_host TEXT NOT NULL DEFAULT 'github.com',
                homepage TEXT,
                platforms_json TEXT NOT NULL DEFAULT '[]',
                changelog TEXT NOT NULL DEFAULT '',
                readme_markdown TEXT NOT NULL DEFAULT '',
                readme_variants_json TEXT,
                releases_json TEXT NOT NULL DEFAULT '[]',
                cached_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE api_etag_cache (
                endpoint_url TEXT PRIMARY KEY,
                etag TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                last_checked_at INTEGER NOT NULL
            );
            CREATE TABLE user_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- 1. catalog_apps 内置 Maccy 被老版误写入 ["windows"]
            INSERT INTO catalog_apps (id, name, owner, repo, category, category_name, platforms_json, identifiers_json)
            VALUES ('p0deje/maccy', 'Maccy', 'p0deje', 'Maccy', 'system', '系统实用', '["windows"]', '{"macos":["Maccy.app"],"windows":[]}');

            -- 2. catalog_apps 非内置条目但有 app_details .app.zip 证据
            INSERT INTO catalog_apps (id, name, owner, repo, category, category_name, platforms_json, identifiers_json)
            VALUES ('acme/mac-only', 'MacOnly', 'acme', 'mac-only', 'tools', '效率工具', '["windows"]', '{}');
            INSERT INTO app_details (app_id, name, owner, repo, releases_json)
            VALUES ('acme/mac-only', 'MacOnly', 'acme', 'mac-only', '[{"name":"MacOnly.app.zip","download_url":"https://example.com/MacOnly.app.zip","size_bytes":5000000,"sha256":null,"os":"windows","arch":"universal","kind":"portable_zip"}]');

            -- 3. custom_apps：一个与截图同构（platforms=["windows"] 且 identifiers.macos=["Maccy.app"]），另一个是真 Windows 应用
            INSERT INTO custom_apps (id, payload_json, status, created_at, updated_at, archived)
            VALUES (
                'custom/maccy-like',
                '{"id":"custom/maccy-like","name":"Maccy","owner":"custom","repo":"maccy-like","icon":"","icon_bg":"","description":"desc","category":"system","category_name":"系统实用","aliases":[],"default_version":"1.0","license":"MIT","stars":1,"forks":0,"is_verified":false,"platforms":["windows"],"identifiers":{"macos":["Maccy.app"],"windows":[]}}',
                'collected',
                100,
                200,
                0
            );
            INSERT INTO custom_apps (id, payload_json, status, created_at, updated_at, archived)
            VALUES (
                'custom/win-app',
                '{"id":"custom/win-app","name":"WinApp","owner":"custom","repo":"win-app","icon":"","icon_bg":"","description":"desc","category":"system","category_name":"系统实用","aliases":[],"default_version":"1.0","license":"MIT","stars":1,"forks":0,"is_verified":false,"platforms":["windows"],"identifiers":{"windows":["winapp.exe"],"macos":[]}}',
                'collected',
                100,
                200,
                0
            );

            -- 4. 清单 ETag 与同步周期记录应被清掉，其它 ETag 保留
            INSERT INTO api_etag_cache VALUES ('https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json', 'W/"cat"', '[]', 100);
            INSERT INTO api_etag_cache VALUES ('https://api.github.com/repos/o/r', 'W/"repo"', '{}', 100);
            INSERT INTO user_settings VALUES ('catalog_last_synced_day', '2026-11-15');
            INSERT INTO user_settings VALUES ('catalog_last_synced_url', 'https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json');

            PRAGMA user_version = 6;
            "#,
        )
        .unwrap();

        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);

        let maccy = db.get_catalog_app("p0deje/maccy").unwrap().unwrap();
        assert_eq!(maccy.platforms, vec!["macos"]);

        let mac_only = db.get_catalog_app("acme/mac-only").unwrap().unwrap();
        assert_eq!(mac_only.platforms, vec!["macos"]);

        let custom_mac = db.get_custom_app("custom/maccy-like").unwrap().unwrap();
        assert_eq!(custom_mac.item.platforms, vec!["macos"]);
        assert_eq!(custom_mac.updated_at, 200);

        let custom_win = db.get_custom_app("custom/win-app").unwrap().unwrap();
        assert_eq!(custom_win.item.platforms, vec!["windows"]);

        assert!(db
            .get_etag(
                "https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json"
            )
            .unwrap()
            .is_none());
        assert!(db
            .get_etag("https://api.github.com/repos/o/r")
            .unwrap()
            .is_some());
        assert!(db.get_setting("catalog_last_synced_day").unwrap().is_none());
    }

    #[test]
    fn migrate_v8_to_v9_creates_launchpad_discussion_cache() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 8;").unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);
        db.record_launchpad_upvote("superMC5657/z-store-launchpad", 3, "D_3", 5, true, 100)
            .unwrap();
        let st = db
            .get_launchpad_discussion_state("supermc5657/z-store-launchpad", 3)
            .unwrap()
            .unwrap();
        assert_eq!(st.upvote_count, 5);
        assert_eq!(st.viewer_has_upvoted, Some(true));
    }
}
