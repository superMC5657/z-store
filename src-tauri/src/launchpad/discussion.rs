//! 广场讨论读写：已登录 GraphQL、未登录匿名 REST 只读降级；读写结果写透本地脉冲表，
//! 写操作成功后由本模块失效对应的匿名 REST `ETag Cache`。

use super::{
    LaunchpadDiscussionComment, LaunchpadDiscussionDetail, LaunchpadReactionGroup,
    LaunchpadUpvoteResult,
};
use crate::db::{Database, LaunchpadDiscussionUpsert};
use crate::github::discussions::{self as gd, AnonCacheScope};
use std::sync::Mutex;

/// 已校验的讨论坐标（双段 GitHub `owner/repo` + 正整数编号）。
#[derive(Debug, Clone)]
struct DiscussionTarget {
    owner: String,
    repo: String,
    number: u64,
}

impl DiscussionTarget {
    fn parse(discussion_repo: &str, discussion_number: u64) -> Result<Self, String> {
        let (owner, repo) = gd::validate_discussion_repo(discussion_repo)?;
        let number = gd::validate_discussion_number(discussion_number)?;
        Ok(Self {
            owner,
            repo,
            number,
        })
    }

    fn as_ref(&self) -> gd::DiscussionRef<'_> {
        gd::DiscussionRef {
            owner: &self.owner,
            repo: &self.repo,
            number: self.number,
        }
    }

    fn coord(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// 讨论读写上下文：数据库、HTTP Client、GitHub API 基址与当前登录令牌。
pub(crate) struct LaunchpadDiscussions<'a> {
    pub db: &'a Mutex<Database>,
    pub client: reqwest::Client,
    pub api_base: &'a str,
    pub token: Option<String>,
}

impl LaunchpadDiscussions<'_> {
    fn authed(&self, login_hint: &str) -> Result<gd::DiscussionClient<'_>, String> {
        let token = self
            .token
            .as_deref()
            .ok_or_else(|| login_hint.to_string())?;
        Ok(gd::DiscussionClient {
            client: &self.client,
            api_base: self.api_base,
            token,
        })
    }

    fn with_db(&self, f: impl FnOnce(&Database)) {
        if let Ok(db) = self.db.lock() {
            f(&db);
        }
    }

    fn invalidate(&self, target: &DiscussionTarget, scope: AnonCacheScope) {
        self.with_db(|db| gd::invalidate_anonymous_cache(db, target.as_ref(), scope));
    }

    /// 读取讨论：已登录 GraphQL（首页结果回写脉冲表）；未登录仅首页走匿名 REST，
    /// 回写后以库内合并值夹紧顶帖数，续页返回非 stale 的空壳（续页需登录）。
    pub(crate) async fn get(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
        cursor: Option<&str>,
        force_refresh: bool,
    ) -> Result<LaunchpadDiscussionDetail, String> {
        let target = &DiscussionTarget::parse(discussion_repo, discussion_number)?;
        let cursor = cursor.filter(|c| !c.trim().is_empty());
        let is_first_page = cursor.is_none();
        if let Ok(ctx) = self.authed("") {
            let detail = gd::fetch_discussion_authed(ctx, target.as_ref(), cursor)
                .await
                .map_err(gd::GqlError::into_message)?;
            if is_first_page {
                self.with_db(|db| {
                    let _ = db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
                        discussion_repo: target.coord(),
                        discussion_number: target.number,
                        node_id: (!detail.id.is_empty()).then(|| detail.id.clone()),
                        upvote_count: detail.upvote_count,
                        authoritative_upvotes: true,
                        comments_count: Some(detail.comments_total),
                        viewer_has_upvoted: Some(detail.viewer_has_upvoted),
                        stars: None,
                        forks: None,
                        latest_version: None,
                        synced_at: crate::now_secs(),
                    });
                });
            }
            return Ok(detail);
        }
        if !is_first_page {
            let mut shell = gd::degraded_shell(&target.owner, &target.repo, target.number);
            shell.is_stale = false;
            return Ok(shell);
        }
        let (mut detail, authoritative_upvotes) = gd::fetch_discussion_anonymous(
            self.db,
            &self.client,
            Some(self.api_base),
            &target.owner,
            &target.repo,
            target.number,
            force_refresh,
        )
        .await;
        if !detail.is_stale && !detail.id.is_empty() {
            self.with_db(|db| {
                let _ = db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
                    discussion_repo: target.coord(),
                    discussion_number: target.number,
                    node_id: Some(detail.id.clone()),
                    upvote_count: detail.upvote_count,
                    authoritative_upvotes,
                    comments_count: Some(detail.comments_total),
                    viewer_has_upvoted: None,
                    stars: None,
                    forks: None,
                    latest_version: None,
                    synced_at: crate::now_secs(),
                });
                if let Ok(Some(st)) =
                    db.get_launchpad_discussion_state(&target.coord(), target.number)
                {
                    detail.upvote_count = st.upvote_count;
                }
            });
        }
        Ok(detail)
    }

    /// 发表评论或回复：评论数写透脉冲表，失效主帖与评论匿名缓存。
    pub(crate) async fn add_comment(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
        discussion_id: Option<&str>,
        body: &str,
        reply_to_id: Option<&str>,
    ) -> Result<LaunchpadDiscussionComment, String> {
        let ctx = self.authed("请先登录 GitHub 账号后再发表评论")?;
        let target = &DiscussionTarget::parse(discussion_repo, discussion_number)?;
        let comment =
            gd::add_comment(ctx, target.as_ref(), discussion_id, body, reply_to_id).await?;
        self.with_db(|db| {
            let _ = db.record_launchpad_comment_added(
                &target.coord(),
                target.number,
                discussion_id,
                crate::now_secs(),
            );
        });
        self.invalidate(target, AnonCacheScope::All);
        Ok(comment)
    }

    /// 主帖顶帖 / 取消：原生 Upvote 优先、受限回退 👍 Reaction；结果写透脉冲表，失效主帖匿名缓存。
    pub(crate) async fn toggle_upvote(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
        subject_id: Option<&str>,
        currently_upvoted: bool,
    ) -> Result<LaunchpadUpvoteResult, String> {
        let ctx = self.authed("请先登录 GitHub 账号后再顶帖")?;
        let target = &DiscussionTarget::parse(discussion_repo, discussion_number)?;
        let result = gd::toggle_upvote(ctx, target.as_ref(), subject_id, currently_upvoted).await?;
        self.with_db(|db| {
            let _ = db.record_launchpad_upvote(
                &target.coord(),
                target.number,
                &result.subject_id,
                result.upvote_count,
                result.viewer_has_upvoted,
                crate::now_secs(),
            );
        });
        self.invalidate(target, AnonCacheScope::Discussion);
        Ok(result)
    }

    /// 一级评论顶帖 / 取消：不写脉冲表，仅失效评论匿名缓存。
    pub(crate) async fn toggle_comment_upvote(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
        comment_id: &str,
        currently_upvoted: bool,
    ) -> Result<LaunchpadUpvoteResult, String> {
        let ctx = self.authed("请先登录 GitHub 账号后再顶帖")?;
        let target = &DiscussionTarget::parse(discussion_repo, discussion_number)?;
        let result = gd::toggle_comment_upvote(ctx, comment_id, currently_upvoted).await?;
        self.invalidate(target, AnonCacheScope::Comments);
        Ok(result)
    }

    /// 主帖 / 评论（含二级回复）Emoji Reaction 切换：失效主帖与评论匿名缓存。
    pub(crate) async fn toggle_reaction(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
        subject_id: &str,
        content: &str,
        currently_reacted: bool,
    ) -> Result<Vec<LaunchpadReactionGroup>, String> {
        let ctx = self.authed("请先登录 GitHub 账号后再添加表情回应")?;
        let target = &DiscussionTarget::parse(discussion_repo, discussion_number)?;
        let groups = gd::toggle_reaction(ctx, subject_id, content, currently_reacted).await?;
        self.invalidate(target, AnonCacheScope::All);
        Ok(groups)
    }
}
