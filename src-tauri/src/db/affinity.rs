use super::{clean, now_secs, Database};
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

/// 用户与 GitHub 仓库的显式关联类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RepoRelation {
    Starred,
    Forked,
    Owned,
}

impl RepoRelation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starred => "starred",
            Self::Forked => "forked",
            Self::Owned => "owned",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "starred" => Some(Self::Starred),
            "forked" => Some(Self::Forked),
            "owned" => Some(Self::Owned),
            _ => None,
        }
    }
}

/// 用户 GitHub 账号下关联仓库的特征信号（本地 SQLite 持久化）。
/// `relation` 取值：`"starred"` | `"forked"` | `"owned"`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserRepoSignal {
    pub full_name: String,
    pub relation: String,
    pub language: String,
    pub description: String,
    pub stars: u64,
    pub forks: u64,
    pub updated_at: i64,
}

impl UserRepoSignal {
    pub fn relation_kind(&self) -> Option<RepoRelation> {
        RepoRelation::parse(&self.relation)
    }
}

/// 推荐负反馈的作用范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FeedbackScope {
    /// 单个应用：不进推荐区块，主流中沉底。
    App,
    /// 整个分类：画像中该分类权重减半。
    Category,
}

impl FeedbackScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Category => "category",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "app" => Some(Self::App),
            "category" => Some(Self::Category),
            _ => None,
        }
    }
}

/// 一条推荐负反馈。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedFeedback {
    pub target: String,
    pub scope: FeedbackScope,
    pub created_at: i64,
}

/// 推荐负反馈有效期（秒）。
pub const FEED_FEEDBACK_TTL_SECS: i64 = 90 * 86400;
/// 画像读取的最近搜索词条数上限。
pub const AFFINITY_SEARCH_LIMIT: usize = 20;

/// 本地亲和度画像的原始信号快照（零网络一次性从 SQLite 读取）。
/// 汇总 GitHub Star/Fork/Owned 仓库特征、应用内 Star/收藏/关注、已安装、浏览与搜索历史、
/// 兴趣种子以及有效期内的推荐负反馈。
#[derive(Debug, Clone, Default)]
pub struct RawAffinitySignals {
    pub repo_signals: Vec<UserRepoSignal>,
    pub user_stars: Vec<(String, i64)>,
    pub favorites: Vec<(String, i64)>,
    pub watched: Vec<(String, i64)>,
    pub installed: Vec<(String, i64)>,
    pub views: Vec<(String, i64)>,
    pub searches: Vec<(String, i64)>,
    pub interest_seeds: Vec<String>,
    pub feedback: Vec<FeedFeedback>,
}

impl Database {
    fn insert_user_repo_signal_rows(
        &self,
        signals: &[UserRepoSignal],
        default_now: i64,
    ) -> Result<()> {
        for sig in signals {
            let Some(full_name) = crate::forge::canonical_app_id(&sig.full_name) else {
                continue;
            };
            let relation = clean(&sig.relation).to_lowercase();
            if relation.is_empty() {
                continue;
            }
            let updated_at = if sig.updated_at > 0 {
                sig.updated_at
            } else {
                default_now
            };
            self.exec_write(
                r#"
                INSERT INTO user_repo_signals (
                    full_name, relation, language, description, stars, forks, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(full_name, relation) DO UPDATE SET
                    language = excluded.language,
                    description = excluded.description,
                    stars = excluded.stars,
                    forks = excluded.forks,
                    updated_at = excluded.updated_at
                "#,
                params![
                    full_name,
                    relation,
                    clean(&sig.language),
                    clean(&sig.description),
                    sig.stars as i64,
                    sig.forks as i64,
                    updated_at,
                ],
            )?;
        }
        Ok(())
    }

    /// 批量写入或更新用户仓库特征信号（事务化）。
    pub fn upsert_user_repo_signals(&self, signals: &[UserRepoSignal]) -> Result<()> {
        if signals.is_empty() {
            return Ok(());
        }
        let default_now = now_secs();
        self.with_immediate_transaction(|| self.insert_user_repo_signal_rows(signals, default_now))
    }

    /// 按指定 `relations` 集合原子替换本地仓库特征信号（用于增量同步 200 OK 时刷新特定关系槽位）。
    pub fn replace_user_repo_signals_by_relations(
        &self,
        relations: &[&str],
        signals: &[UserRepoSignal],
    ) -> Result<()> {
        let default_now = now_secs();
        self.with_immediate_transaction(|| {
            for rel in relations {
                let r = clean(rel).to_lowercase();
                if !r.is_empty() {
                    self.exec_write(
                        "DELETE FROM user_repo_signals WHERE relation = ?1",
                        params![r],
                    )?;
                }
            }
            self.insert_user_repo_signal_rows(signals, default_now)
        })
    }

    /// 移除单条用户仓库特征信号（如应用内取消 Star 时同步清理 `'starred'` 信号）。
    pub fn remove_user_repo_signal(&self, full_name: &str, relation: &str) -> Result<()> {
        let name = crate::forge::canonical_app_id(full_name)
            .unwrap_or_else(|| clean(full_name).to_lowercase());
        let rel = clean(relation).to_lowercase();
        self.exec_write(
            "DELETE FROM user_repo_signals WHERE full_name = ?1 AND relation = ?2",
            params![name, rel],
        )?;
        Ok(())
    }

    /// 退出 GitHub 账号时清理与账号绑定的仓库信号、`user_stars` 及同步时间戳。
    pub fn clear_github_account_signals(&self) -> Result<()> {
        self.with_immediate_transaction(|| {
            self.exec_write("DELETE FROM user_repo_signals", [])?;
            self.exec_write("DELETE FROM user_stars", [])?;
            self.exec_write(
                "DELETE FROM user_settings WHERE key = 'affinity_github_synced_at'",
                [],
            )?;
            Ok(())
        })?;
        crate::notify_affinity_updated();
        Ok(())
    }

    /// 整体替换兴趣种子（分类 key 小写去重；调用方负责校验取值）。
    pub fn replace_interest_seeds(&self, categories: &[String]) -> Result<()> {
        let now = now_secs();
        self.with_immediate_transaction(|| {
            self.exec_write("DELETE FROM user_interest_seeds", [])?;
            for cat in categories {
                let key = clean(cat).to_lowercase();
                if key.is_empty() {
                    continue;
                }
                self.exec_write(
                    "INSERT OR IGNORE INTO user_interest_seeds (category, created_at) VALUES (?1, ?2)",
                    params![key, now],
                )?;
            }
            Ok(())
        })?;
        crate::notify_affinity_updated();
        Ok(())
    }

    /// 读取兴趣种子（按分类 key 升序）。
    pub fn get_interest_seeds(&self) -> Result<Vec<String>> {
        self.query_vec(
            "SELECT category FROM user_interest_seeds ORDER BY category ASC",
            [],
            |row| row.get(0),
        )
    }

    /// 记录一条推荐负反馈（同 target+scope 重复记录刷新时间）。
    pub fn upsert_feed_feedback(&self, target: &str, scope: FeedbackScope, now: i64) -> Result<()> {
        let key = clean(target).to_lowercase();
        if key.is_empty() {
            return Ok(());
        }
        self.exec_write(
            r#"
            INSERT INTO user_feed_feedback (target, scope, created_at) VALUES (?1, ?2, ?3)
            ON CONFLICT(target, scope) DO UPDATE SET created_at = excluded.created_at
            "#,
            params![key, scope.as_str(), now],
        )?;
        crate::notify_affinity_updated();
        Ok(())
    }

    /// 读取有效期内（`now - created_at < 90 天`）的推荐负反馈。
    pub fn get_active_feed_feedback(&self, now: i64) -> Result<Vec<FeedFeedback>> {
        let rows: Vec<(String, String, i64)> = self.query_vec(
            "SELECT target, scope, created_at FROM user_feed_feedback WHERE created_at > ?1 ORDER BY created_at DESC",
            params![now - FEED_FEEDBACK_TTL_SECS],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(rows
            .into_iter()
            .filter_map(|(target, scope, created_at)| {
                Some(FeedFeedback {
                    target,
                    scope: FeedbackScope::parse(&scope)?,
                    created_at,
                })
            })
            .collect())
    }

    /// 清空全部推荐负反馈，返回删除行数。
    pub fn clear_feed_feedback(&self) -> Result<usize> {
        let count: i64 = self
            .query_scalar_opt("SELECT COUNT(1) FROM user_feed_feedback", [])?
            .unwrap_or(0);
        self.exec_write("DELETE FROM user_feed_feedback", [])?;
        crate::notify_affinity_updated();
        Ok(count.max(0) as usize)
    }

    /// 判断本地是否已存在指定 `relations` 集合中的任意仓库特征信号。
    pub fn has_user_repo_signals_for_relations(&self, relations: &[&str]) -> bool {
        for rel in relations {
            let r = clean(rel).to_lowercase();
            if r.is_empty() {
                continue;
            }
            let count: i64 = self
                .query_scalar_opt(
                    "SELECT COUNT(1) FROM user_repo_signals WHERE relation = ?1",
                    params![r],
                )
                .ok()
                .flatten()
                .unwrap_or(0);
            if count > 0 {
                return true;
            }
        }
        false
    }

    /// 读取本地持久化的全部 GitHub 仓库特征信号（按 `updated_at` 倒序）。
    pub fn get_user_repo_signals(&self) -> Result<Vec<UserRepoSignal>> {
        self.query_vec(
            r#"
            SELECT full_name, relation, language, description, stars, forks, updated_at
            FROM user_repo_signals
            ORDER BY updated_at DESC, full_name ASC
            "#,
            [],
            |row| {
                Ok(UserRepoSignal {
                    full_name: row.get(0)?,
                    relation: row.get(1)?,
                    language: row.get(2)?,
                    description: row.get(3)?,
                    stars: row.get::<_, i64>(4)?.max(0) as u64,
                    forks: row.get::<_, i64>(5)?.max(0) as u64,
                    updated_at: row.get(6)?,
                })
            },
        )
    }

    /// 一次性加载画像所需的全部本地信号。
    pub fn load_raw_affinity_signals(&self) -> Result<RawAffinitySignals> {
        let repo_signals = self.get_user_repo_signals()?;
        let user_stars = self.query_vec(
            "SELECT owner, repo, starred_at FROM user_stars ORDER BY starred_at DESC",
            [],
            |row| {
                let owner: String = row.get(0)?;
                let repo: String = row.get(1)?;
                let starred_at: i64 = row.get(2)?;
                Ok((
                    crate::forge::canonical_app_id_from_parts(&owner, &repo),
                    starred_at,
                ))
            },
        )?;
        let favorites = self.query_vec(
            "SELECT app_id, favorited_at FROM user_favorites ORDER BY favorited_at DESC",
            [],
            |row| {
                let app_id: String = row.get(0)?;
                let favorited_at: i64 = row.get(1)?;
                Ok((app_id.to_lowercase(), favorited_at))
            },
        )?;
        let watched = self.query_vec(
            "SELECT app_id, added_at FROM watched_apps ORDER BY added_at DESC",
            [],
            |row| {
                let app_id: String = row.get(0)?;
                let added_at: i64 = row.get(1)?;
                Ok((app_id.to_lowercase(), added_at))
            },
        )?;

        let installed = self.query_vec(
            "SELECT app_id, installed_at FROM installed_apps ORDER BY installed_at DESC",
            [],
            |row| {
                let app_id: String = row.get(0)?;
                let installed_at: i64 = row.get(1)?;
                Ok((app_id.to_lowercase(), installed_at))
            },
        )?;
        let view_limit = crate::config::get_project_config()
            .limits
            .view_history_limit;
        let views = self.query_vec(
            &format!(
                "SELECT app_id, viewed_at FROM view_history ORDER BY viewed_at DESC, id DESC LIMIT {}",
                view_limit
            ),
            [],
            |row| {
                let app_id: String = row.get(0)?;
                let viewed_at: i64 = row.get(1)?;
                Ok((app_id.to_lowercase(), viewed_at))
            },
        )?;
        let searches = self.query_vec(
            &format!(
                "SELECT query, searched_at FROM search_history ORDER BY searched_at DESC LIMIT {}",
                AFFINITY_SEARCH_LIMIT
            ),
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let interest_seeds = self.get_interest_seeds()?;
        let feedback = self.get_active_feed_feedback(now_secs())?;

        Ok(RawAffinitySignals {
            repo_signals,
            user_stars,
            favorites,
            watched,
            installed,
            views,
            searches,
            interest_seeds,
            feedback,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn user_repo_signals_crud_and_replace_by_relations() {
        let db = Database::open_in_memory().unwrap();
        let initial = vec![
            UserRepoSignal {
                full_name: "RustDesk/RustDesk".to_string(),
                relation: "starred".to_string(),
                language: "Rust".to_string(),
                description: "An open-source remote desktop".to_string(),
                stars: 70000,
                forks: 8500,
                updated_at: 1700000100,
            },
            UserRepoSignal {
                full_name: "supermc/my-fork".to_string(),
                relation: "forked".to_string(),
                language: "TypeScript".to_string(),
                description: "Forked web client".to_string(),
                stars: 12,
                forks: 3,
                updated_at: 1700000200,
            },
            UserRepoSignal {
                full_name: "supermc/z-tool".to_string(),
                relation: "owned".to_string(),
                language: "Rust".to_string(),
                description: "CLI utility".to_string(),
                stars: 50,
                forks: 4,
                updated_at: 1700000300,
            },
        ];

        db.upsert_user_repo_signals(&initial).unwrap();
        let stored = db.get_user_repo_signals().unwrap();
        assert_eq!(stored.len(), 3);
        assert_eq!(stored[0].full_name, "supermc/z-tool");
        assert_eq!(stored[2].full_name, "rustdesk/rustdesk");
        assert_eq!(stored[2].stars, 70000);
        assert_eq!(stored[2].forks, 8500);

        // 仅替换 forked 与 owned，保留 starred
        let replacement = vec![UserRepoSignal {
            full_name: "supermc/new-fork".to_string(),
            relation: "forked".to_string(),
            language: "Go".to_string(),
            description: "Kubernetes operator".to_string(),
            stars: 100,
            forks: 20,
            updated_at: 1700000400,
        }];
        db.replace_user_repo_signals_by_relations(&["forked", "owned"], &replacement)
            .unwrap();

        let after_replace = db.get_user_repo_signals().unwrap();
        assert_eq!(after_replace.len(), 2);
        assert!(after_replace
            .iter()
            .any(|s| s.full_name == "rustdesk/rustdesk" && s.relation == "starred"));
        assert!(after_replace
            .iter()
            .any(|s| s.full_name == "supermc/new-fork" && s.relation == "forked"));

        // 移除单条信号
        db.remove_user_repo_signal("RustDesk/RustDesk", "starred")
            .unwrap();
        let after_remove = db.get_user_repo_signals().unwrap();
        assert_eq!(after_remove.len(), 1);
        assert_eq!(after_remove[0].full_name, "supermc/new-fork");
    }

    #[test]
    fn load_raw_affinity_signals_and_clear_account_signals() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_user_repo_signals(&[UserRepoSignal {
            full_name: "mpv-player/mpv".to_string(),
            relation: "starred".to_string(),
            language: "C".to_string(),
            description: "Command line video player".to_string(),
            stars: 28000,
            forks: 2900,
            updated_at: 1700000500,
        }])
        .unwrap();
        db.set_starred("ObsidianMD", "obsidian-releases", true)
            .unwrap();
        db.add_favorite("localsend/localsend", true).unwrap();
        db.watch_app("bitwarden/clients", true).unwrap();
        db.set_setting("affinity_github_synced_at", "1700000500")
            .unwrap();

        let raw = db.load_raw_affinity_signals().unwrap();
        assert_eq!(raw.repo_signals.len(), 1);
        assert_eq!(raw.repo_signals[0].full_name, "mpv-player/mpv");
        assert_eq!(raw.user_stars.len(), 1);
        assert_eq!(raw.user_stars[0].0, "obsidianmd/obsidian-releases");
        assert_eq!(raw.favorites.len(), 1);
        assert_eq!(raw.favorites[0].0, "localsend/localsend");
        assert_eq!(raw.watched.len(), 1);
        assert_eq!(raw.watched[0].0, "bitwarden/clients");

        // 账号登出清理：清空 repo_signals、user_stars 与同步时间戳，但保留本地收藏与关注
        db.clear_github_account_signals().unwrap();
        let raw_after = db.load_raw_affinity_signals().unwrap();
        assert!(raw_after.repo_signals.is_empty());
        assert!(raw_after.user_stars.is_empty());
        assert_eq!(raw_after.favorites.len(), 1);
        assert_eq!(raw_after.watched.len(), 1);
        assert!(db
            .get_setting("affinity_github_synced_at")
            .unwrap()
            .is_none());
    }

    #[test]
    fn load_raw_affinity_signals_reads_installed_views_and_searches() {
        let db = Database::open_in_memory().unwrap();
        db.exec_write(
            "INSERT INTO installed_apps (app_id, app_name, version, installed_at, install_method, install_path, asset_name, asset_sha256) VALUES ('Obsidian/Obsidian', 'Obsidian', '1.0', 1700000000, 'msi', 'C:/x', 'a.msi', '')",
            [],
        )
        .unwrap();
        db.record_app_view_at("logseq/logseq", 1_700_000_000)
            .unwrap();
        db.record_app_view_at("logseq/logseq", 1_700_000_400)
            .unwrap();
        db.record_search_query("markdown notes").unwrap();

        let raw = db.load_raw_affinity_signals().unwrap();
        assert_eq!(
            raw.installed,
            vec![("obsidian/obsidian".to_string(), 1700000000)]
        );
        assert_eq!(
            raw.views,
            vec![
                ("logseq/logseq".to_string(), 1_700_000_400),
                ("logseq/logseq".to_string(), 1_700_000_000),
            ]
        );
        assert_eq!(raw.searches.len(), 1);
        assert_eq!(raw.searches[0].0, "markdown notes");
    }

    #[test]
    fn interest_seeds_replace_and_read() {
        let db = Database::open_in_memory().unwrap();
        db.replace_interest_seeds(&["Dev".to_string(), "media".to_string(), "dev".to_string()])
            .unwrap();
        assert_eq!(db.get_interest_seeds().unwrap(), vec!["dev", "media"]);
        db.replace_interest_seeds(&["games".to_string()]).unwrap();
        assert_eq!(db.get_interest_seeds().unwrap(), vec!["games"]);
        assert_eq!(
            db.load_raw_affinity_signals().unwrap().interest_seeds,
            vec!["games"]
        );
    }

    #[test]
    fn feed_feedback_expires_after_ttl_and_clears() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_800_000_000i64;
        db.upsert_feed_feedback("Foo/Bar", FeedbackScope::App, now - 10)
            .unwrap();
        db.upsert_feed_feedback("games", FeedbackScope::Category, now - 91 * 86400)
            .unwrap();
        let active = db.get_active_feed_feedback(now).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].target, "foo/bar");
        assert_eq!(active[0].scope, FeedbackScope::App);
        assert_eq!(db.clear_feed_feedback().unwrap(), 2);
        assert!(db.get_active_feed_feedback(now).unwrap().is_empty());
    }
}
