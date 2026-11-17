//! GitHub Discussions 混合通道（开源广场讨论区）：
//! - 已登录：GraphQL 参数化查询/变更（`variables` 绑定，绝不拼接查询体），
//!   复用现行 `public_repo user` 授权，无需重新授权；
//! - 未登录：匿名 REST + `api_etag_cache` 只读降级，限流/离线回退旧载荷或结构化空壳。

use crate::db::Database;
use crate::launchpad::{
    LaunchpadDiscussionAuthor, LaunchpadDiscussionComment, LaunchpadDiscussionDetail,
    LaunchpadReactionGroup, LaunchpadUpvoteResult, LaunchpadVoteMode,
};
use serde_json::{json, Value};
use std::sync::Mutex;

/// 已登录 GitHub GraphQL 调用上下文。
#[derive(Debug, Clone, Copy)]
pub struct DiscussionClient<'a> {
    pub client: &'a reqwest::Client,
    pub api_base: &'a str,
    pub token: &'a str,
}

/// 讨论目标坐标（已校验的双段 GitHub `owner/repo` + 讨论编号）。
#[derive(Debug, Clone, Copy)]
pub struct DiscussionRef<'a> {
    pub owner: &'a str,
    pub repo: &'a str,
    pub number: u64,
}

/// 评论正文字符上限。
pub const COMMENT_MAX_CHARS: usize = 10_000;
/// 一级评论单页数量。
pub const COMMENTS_PAGE_SIZE: u32 = 30;

const DISCUSSION_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      id number title body url createdAt locked closed
      category { name }
      author { login avatarUrl url }
      upvoteCount viewerCanUpvote viewerHasUpvoted
      reactionGroups { content viewerHasReacted reactors { totalCount } }
      comments(first: 30, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id body createdAt authorAssociation
          author { login avatarUrl url }
          upvoteCount viewerHasUpvoted
          reactionGroups { content viewerHasReacted reactors { totalCount } }
          replies(first: 20) {
            totalCount
            nodes {
              id body createdAt authorAssociation
              author { login avatarUrl url }
              upvoteCount viewerHasUpvoted
              reactionGroups { content viewerHasReacted reactors { totalCount } }
            }
          }
        }
      }
    }
  }
}"#;

const DISCUSSION_ID_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) { id locked viewerCanUpvote }
  }
}"#;

const ADD_COMMENT_MUTATION: &str = r#"
mutation($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) {
    comment {
      id body createdAt authorAssociation
      author { login avatarUrl url }
      upvoteCount viewerHasUpvoted
      reactionGroups { content viewerHasReacted reactors { totalCount } }
    }
  }
}"#;

const ADD_UPVOTE_MUTATION: &str = r#"
mutation($subjectId: ID!) {
  addUpvote(input: { subjectId: $subjectId }) {
    subject { ... on Node { id } upvoteCount viewerHasUpvoted }
  }
}"#;

const REMOVE_UPVOTE_MUTATION: &str = r#"
mutation($subjectId: ID!) {
  removeUpvote(input: { subjectId: $subjectId }) {
    subject { ... on Node { id } upvoteCount viewerHasUpvoted }
  }
}"#;

const ADD_REACTION_MUTATION: &str = r#"
mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) {
    subject { id reactionGroups { content viewerHasReacted reactors { totalCount } } }
  }
}"#;

const REMOVE_REACTION_MUTATION: &str = r#"
mutation($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) {
    subject { id reactionGroups { content viewerHasReacted reactors { totalCount } } }
  }
}"#;

const ALLOWED_REACTION_CONTENTS: &[&str] = &[
    "THUMBS_UP",
    "THUMBS_DOWN",
    "LAUGH",
    "HOORAY",
    "CONFUSED",
    "HEART",
    "ROCKET",
    "EYES",
];

const REST_REACTION_KEYS: &[(&str, &str)] = &[
    ("+1", "THUMBS_UP"),
    ("-1", "THUMBS_DOWN"),
    ("laugh", "LAUGH"),
    ("hooray", "HOORAY"),
    ("confused", "CONFUSED"),
    ("heart", "HEART"),
    ("rocket", "ROCKET"),
    ("eyes", "EYES"),
];

/// 讨论仓坐标校验：仅接受双段 GitHub `owner/repo`，拒绝路径穿越、查询/锚点、
/// forge 前缀与控制字符（防 SSRF 与路径注入）。
pub fn validate_discussion_repo(raw: &str) -> Result<(String, String), String> {
    let t = raw.trim();
    let invalid = || format!("无效的讨论仓库坐标: {}", crate::log_support::short_reason(raw));
    if t.is_empty()
        || t.contains("..")
        || t.chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '?' | '#' | ':' | '\\' | '%'))
    {
        return Err(invalid());
    }
    let mut parts = t.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invalid());
    };
    if owner.is_empty() || repo.is_empty() {
        return Err(invalid());
    }
    crate::oauth::split_github_repo_id(t).map_err(|_| invalid())
}

pub fn validate_discussion_number(n: u64) -> Result<u64, String> {
    if n == 0 || n > i32::MAX as u64 {
        return Err("无效的讨论编号".to_string());
    }
    Ok(n)
}

/// 讨论网页确定性地址。
pub fn discussion_html_url(owner: &str, repo: &str, number: u64) -> String {
    format!("https://github.com/{}/{}/discussions/{}", owner, repo, number)
}

/// 匿名 REST 端点（`api_etag_cache` 键，恒用官方基址）。
pub fn rest_discussion_url(owner: &str, repo: &str, number: u64) -> String {
    format!(
        "{}/repos/{}/{}/discussions/{}",
        super::GITHUB_API_BASE,
        owner,
        repo,
        number
    )
}

pub fn rest_comments_url(owner: &str, repo: &str, number: u64) -> String {
    format!(
        "{}/comments?per_page={}",
        rest_discussion_url(owner, repo, number),
        COMMENTS_PAGE_SIZE
    )
}

/// GraphQL 调用错误分类。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GqlError {
    Unauthorized,
    /// `FORBIDDEN` / "Resource not accessible by integration"：顶帖回退 Reaction。
    Forbidden(String),
    /// 分类未开投票或 `UNPROCESSABLE`：顶帖回退 Reaction。
    UpvoteUnavailable(String),
    InsufficientScopes,
    Other(String),
}

impl GqlError {
    pub fn into_message(self) -> String {
        match self {
            GqlError::Unauthorized => "GitHub 授权已失效 (401)，请重新登录".to_string(),
            GqlError::Forbidden(m) => format!("GitHub 拒绝了该操作: {}", m),
            GqlError::UpvoteUnavailable(m) => format!("当前讨论不支持投票: {}", m),
            GqlError::InsufficientScopes => {
                "当前 GitHub 授权缺少所需权限，请在设置中重新登录".to_string()
            }
            GqlError::Other(m) => m,
        }
    }
}

/// 从 GraphQL 响应体提取 `data` 或映射 `errors`（纯函数）。
pub fn map_graphql_response(body: &Value) -> Result<&Value, GqlError> {
    if let Some(errors) = body.get("errors").and_then(|e| e.as_array()) {
        if let Some(first) = errors.first() {
            let kind = first.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let message = first
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("GraphQL 请求失败")
                .to_string();
            let lower = message.to_ascii_lowercase();
            return Err(match kind {
                "INSUFFICIENT_SCOPES" => GqlError::InsufficientScopes,
                "FORBIDDEN" => GqlError::Forbidden(message),
                _ if message.contains("Resource not accessible by integration") => {
                    GqlError::Forbidden(message)
                }
                "UNPROCESSABLE" => GqlError::UpvoteUnavailable(message),
                _ if lower.contains("upvote") || lower.contains("voting") => {
                    GqlError::UpvoteUnavailable(message)
                }
                _ => GqlError::Other(message),
            });
        }
    }
    body.get("data")
        .filter(|d| !d.is_null())
        .ok_or_else(|| GqlError::Other("GraphQL 响应缺少 data".to_string()))
}

async fn graphql_post_raw(
    ctx: DiscussionClient<'_>,
    query: &str,
    variables: Value,
    op: &str,
) -> Result<Value, GqlError> {
    let headers = crate::forge::http::api_headers(
        crate::forge::http::GITHUB_ACCEPT_VALUE,
        Some(ctx.token),
        crate::forge::http::AuthScheme::Bearer,
    );
    let resp = ctx
        .client
        .post(format!("{}/graphql", ctx.api_base.trim_end_matches('/')))
        .headers(headers)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| {
            crate::proxy::note_transport_error(&e);
            GqlError::Other(format!("请求 GitHub 讨论接口失败: {}", e))
        })?;
    crate::notify_rate_limit("github.com", resp.headers());
    let status = resp.status().as_u16();
    if crate::check_auth_expired(status, &format!("op={op}")) {
        return Err(GqlError::Unauthorized);
    }
    if status == 403 {
        return Err(GqlError::Forbidden(format!("HTTP {status}")));
    }
    if !(200..300).contains(&status) {
        return Err(GqlError::Other(format!(
            "GitHub 讨论接口返回 HTTP 状态码: {status}"
        )));
    }
    resp.json()
        .await
        .map_err(|e| GqlError::Other(format!("解析 GitHub 讨论响应失败: {}", e)))
}

async fn graphql_post(
    ctx: DiscussionClient<'_>,
    query: &str,
    variables: Value,
    op: &str,
) -> Result<Value, GqlError> {
    let body = graphql_post_raw(ctx, query, variables, op).await?;
    map_graphql_response(&body).cloned()
}

fn sum_reply_totals(comments: &Value) -> u64 {
    comments
        .get("nodes")
        .and_then(|n| n.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|node| node.get("replies"))
                .map(|r| u64_field(r, "totalCount"))
                .sum()
        })
        .unwrap_or(0)
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string()
}

fn u64_field(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn bool_field(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn gql_author(v: &Value) -> Option<LaunchpadDiscussionAuthor> {
    let a = v.get("author").filter(|a| a.is_object())?;
    let login = str_field(a, "login");
    if login.is_empty() {
        return None;
    }
    Some(LaunchpadDiscussionAuthor {
        avatar_url: crate::launchpad::sanitize_icon(&str_field(a, "avatarUrl")),
        html_url: str_field(a, "url"),
        login,
    })
}

fn gql_reaction_groups(subject: &Value) -> Vec<LaunchpadReactionGroup> {
    subject
        .get("reactionGroups")
        .and_then(|g| g.as_array())
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| {
                    let content = g.get("content").and_then(|c| c.as_str())?;
                    if !ALLOWED_REACTION_CONTENTS.contains(&content) {
                        return None;
                    }
                    let count = g.get("reactors").map(|r| u64_field(r, "totalCount")).unwrap_or(0);
                    if count == 0 {
                        return None;
                    }
                    Some(LaunchpadReactionGroup {
                        content: content.to_string(),
                        count,
                        viewer_has_reacted: bool_field(g, "viewerHasReacted"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn rest_reaction_groups(v: &Value) -> Vec<LaunchpadReactionGroup> {
    let Some(reactions) = v.get("reactions").and_then(|r| r.as_object()) else {
        return Vec::new();
    };
    REST_REACTION_KEYS
        .iter()
        .filter_map(|(rest_key, gql_name)| {
            let count = reactions.get(*rest_key).and_then(|n| n.as_u64()).unwrap_or(0);
            (count > 0).then(|| LaunchpadReactionGroup {
                content: (*gql_name).to_string(),
                count,
                viewer_has_reacted: false,
            })
        })
        .collect()
}

fn gql_comment(node: &Value) -> LaunchpadDiscussionComment {
    let replies = node
        .get("replies")
        .and_then(|r| r.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|arr| arr.iter().map(gql_comment).collect())
        .unwrap_or_default();
    LaunchpadDiscussionComment {
        id: str_field(node, "id"),
        body: str_field(node, "body"),
        created_at: str_field(node, "createdAt"),
        author_association: str_field(node, "authorAssociation"),
        author: gql_author(node),
        upvote_count: u64_field(node, "upvoteCount"),
        viewer_has_upvoted: bool_field(node, "viewerHasUpvoted"),
        reaction_groups: gql_reaction_groups(node),
        replies,
    }
}

/// `reactionGroups` 中 👍 的 `(totalCount, viewerHasReacted)`。
fn thumbs_up(subject: &Value) -> (u64, bool) {
    subject
        .get("reactionGroups")
        .and_then(|g| g.as_array())
        .and_then(|groups| {
            groups
                .iter()
                .find(|g| g.get("content").and_then(|c| c.as_str()) == Some("THUMBS_UP"))
        })
        .map(|g| {
            (
                g.get("reactors").map(|r| u64_field(r, "totalCount")).unwrap_or(0),
                bool_field(g, "viewerHasReacted"),
            )
        })
        .unwrap_or((0, false))
}

/// GraphQL `data` → 讨论详情（已登录口径）。
pub fn parse_graphql_discussion(data: &Value) -> Result<LaunchpadDiscussionDetail, String> {
    let d = data
        .get("repository")
        .and_then(|r| r.get("discussion"))
        .filter(|d| d.is_object())
        .ok_or_else(|| "讨论不存在或无权访问".to_string())?;
    let can_upvote = bool_field(d, "viewerCanUpvote");
    let (upvote_count, viewer_has_upvoted) = if can_upvote {
        (u64_field(d, "upvoteCount"), bool_field(d, "viewerHasUpvoted"))
    } else {
        thumbs_up(d)
    };
    let comments = d.get("comments").cloned().unwrap_or(Value::Null);
    let page = comments.get("pageInfo").cloned().unwrap_or(Value::Null);
    let replies_total = sum_reply_totals(&comments);
    let locked = bool_field(d, "locked");
    Ok(LaunchpadDiscussionDetail {
        id: str_field(d, "id"),
        number: u64_field(d, "number"),
        title: str_field(d, "title"),
        body: str_field(d, "body"),
        url: str_field(d, "url"),
        created_at: str_field(d, "createdAt"),
        locked,
        closed: bool_field(d, "closed"),
        author: gql_author(d),
        category_name: d
            .get("category")
            .map(|c| str_field(c, "name"))
            .unwrap_or_default(),
        upvote_count,
        viewer_has_upvoted,
        viewer_can_upvote: can_upvote,
        viewer_can_comment: !locked,
        auth_required_for_write: false,
        comments_total: u64_field(&comments, "totalCount").saturating_add(replies_total),
        has_next_page: bool_field(&page, "hasNextPage"),
        end_cursor: page
            .get("endCursor")
            .and_then(|c| c.as_str())
            .map(str::to_string),
        reaction_groups: gql_reaction_groups(d),
        comments: comments
            .get("nodes")
            .and_then(|n| n.as_array())
            .map(|arr| arr.iter().map(gql_comment).collect())
            .unwrap_or_default(),
        is_stale: false,
    })
}

/// `addDiscussionComment` 响应 → 新评论。
pub fn parse_added_comment(data: &Value) -> Result<LaunchpadDiscussionComment, String> {
    data.get("addDiscussionComment")
        .and_then(|r| r.get("comment"))
        .filter(|c| c.is_object())
        .map(gql_comment)
        .ok_or_else(|| "发表评论失败：响应缺少评论实体".to_string())
}

/// 顶帖变更响应 → 结果。
pub fn parse_vote_result(
    data: &Value,
    mutation: &str,
    mode: LaunchpadVoteMode,
) -> Result<LaunchpadUpvoteResult, String> {
    let subject = data
        .get(mutation)
        .and_then(|r| r.get("subject"))
        .filter(|s| s.is_object())
        .ok_or_else(|| "顶帖失败：响应缺少目标实体".to_string())?;
    let (count, has) = match mode {
        LaunchpadVoteMode::Reaction => thumbs_up(subject),
        LaunchpadVoteMode::Upvote => (
            u64_field(subject, "upvoteCount"),
            bool_field(subject, "viewerHasUpvoted"),
        ),
    };
    Ok(LaunchpadUpvoteResult {
        subject_id: str_field(subject, "id"),
        upvote_count: count,
        viewer_has_upvoted: has,
        mode,
    })
}

fn rest_author(v: &Value) -> Option<LaunchpadDiscussionAuthor> {
    let a = v.get("user").filter(|a| a.is_object())?;
    let login = str_field(a, "login");
    if login.is_empty() {
        return None;
    }
    Some(LaunchpadDiscussionAuthor {
        avatar_url: crate::launchpad::sanitize_icon(&str_field(a, "avatar_url")),
        html_url: str_field(a, "html_url"),
        login,
    })
}

fn rest_plus_one(v: &Value) -> u64 {
    v.get("reactions").map(|r| u64_field(r, "+1")).unwrap_or(0)
}

/// 结构化降级空壳：带确定性网页地址，前端可引导登录或跳浏览器。
pub fn degraded_shell(owner: &str, repo: &str, number: u64) -> LaunchpadDiscussionDetail {
    LaunchpadDiscussionDetail {
        number,
        url: discussion_html_url(owner, repo, number),
        auth_required_for_write: true,
        is_stale: true,
        ..Default::default()
    }
}

/// 匿名 REST 载荷 → `(只读讨论详情, authoritative_upvotes)`：
/// `comments_json` 缺失时评论列表为空，二级回复按 `parent_id` 归组；
/// 仅当响应含显式 `upvote_count` 时 `authoritative_upvotes` 为 `true`。
pub fn parse_rest_discussion(
    owner: &str,
    repo: &str,
    number: u64,
    discussion_json: &str,
    comments_json: Option<&str>,
) -> Result<(LaunchpadDiscussionDetail, bool), String> {
    let d: Value =
        serde_json::from_str(discussion_json).map_err(|e| format!("解析讨论失败: {}", e))?;
    if !d.is_object() {
        return Err("讨论载荷格式错误".to_string());
    }
    let raw_comments = comments_json
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let raw_count = raw_comments.len() as u64;
    let to_comment = |c: &Value| LaunchpadDiscussionComment {
        id: str_field(c, "node_id"),
        body: str_field(c, "body"),
        created_at: str_field(c, "created_at"),
        author_association: str_field(c, "author_association"),
        author: rest_author(c),
        upvote_count: rest_plus_one(c),
        viewer_has_upvoted: false,
        reaction_groups: rest_reaction_groups(c),
        replies: Vec::new(),
    };
    let mut comments: Vec<LaunchpadDiscussionComment> = Vec::new();
    let mut index_by_rest_id: std::collections::HashMap<u64, usize> =
        std::collections::HashMap::new();
    let mut pending_replies: Vec<(u64, LaunchpadDiscussionComment)> = Vec::new();
    for c in &raw_comments {
        let item = to_comment(c);
        if let Some(pid) = c.get("parent_id").and_then(|p| p.as_u64()) {
            pending_replies.push((pid, item));
        } else {
            if let Some(rest_id) = c.get("id").and_then(|x| x.as_u64()) {
                index_by_rest_id.insert(rest_id, comments.len());
            }
            comments.push(item);
        }
    }
    for (pid, reply) in pending_replies {
        if let Some(&idx) = index_by_rest_id.get(&pid) {
            comments[idx].replies.push(reply);
        } else {
            comments.push(reply);
        }
    }
    let url = str_field(&d, "html_url");
    let total = u64_field(&d, "comments").max(raw_count);
    let explicit_upvotes = d.get("upvote_count").and_then(|n| n.as_u64());
    Ok((
        LaunchpadDiscussionDetail {
            id: str_field(&d, "node_id"),
            number: d.get("number").and_then(|n| n.as_u64()).unwrap_or(number),
            title: str_field(&d, "title"),
            body: str_field(&d, "body"),
            url: if url.is_empty() {
                discussion_html_url(owner, repo, number)
            } else {
                url
            },
            created_at: str_field(&d, "created_at"),
            locked: bool_field(&d, "locked"),
            closed: str_field(&d, "state") == "closed",
            author: rest_author(&d),
            category_name: d
                .get("category")
                .map(|c| str_field(c, "name"))
                .unwrap_or_default(),
            upvote_count: explicit_upvotes.unwrap_or_else(|| rest_plus_one(&d)),
            viewer_has_upvoted: false,
            viewer_can_upvote: false,
            viewer_can_comment: false,
            auth_required_for_write: true,
            comments_total: total,
            has_next_page: total > raw_count,
            end_cursor: None,
            reaction_groups: rest_reaction_groups(&d),
            comments,
            is_stale: false,
        },
        explicit_upvotes.is_some(),
    ))
}

/// 已登录读取：单次 GraphQL 取回主帖、顶帖态与一页评论（含二级回复）。
pub async fn fetch_discussion_authed(
    ctx: DiscussionClient<'_>,
    target: DiscussionRef<'_>,
    cursor: Option<&str>,
) -> Result<LaunchpadDiscussionDetail, GqlError> {
    let data = graphql_post(
        ctx,
        DISCUSSION_QUERY,
        json!({
            "owner": target.owner,
            "repo": target.repo,
            "number": target.number,
            "cursor": cursor
        }),
        "launchpad_discussion",
    )
    .await?;
    parse_graphql_discussion(&data).map_err(GqlError::Other)
}

enum RestLoad {
    Fresh(String),
    Cached(String),
    Missing,
}

async fn rest_get_cached(
    db: &Mutex<Database>,
    client: &reqwest::Client,
    api_base: Option<&str>,
    url: &str,
    force_refresh: bool,
) -> RestLoad {
    let (etag, cached) = match db.lock() {
        Ok(db) => (
            db.get_etag(url).ok().flatten(),
            db.get_cached_payload(url).ok().flatten(),
        ),
        Err(_) => (None, None),
    };
    let cached = cached.filter(|p| !p.trim().is_empty());
    let send_etag = if force_refresh || cached.is_none() {
        None
    } else {
        etag
    };
    let headers = crate::forge::http::api_headers(
        crate::forge::http::GITHUB_ACCEPT_VALUE,
        None,
        crate::forge::http::AuthScheme::Bearer,
    );
    match super::http::get_with_etag(client, url, api_base, &headers, send_etag.as_deref()).await {
        super::http::EtagGetOutcome::Fresh { text, etag } => {
            if let Ok(db) = db.lock() {
                let _ = db.save_etag(
                    url,
                    etag.as_deref().unwrap_or(""),
                    &text,
                    crate::now_secs(),
                );
            }
            RestLoad::Fresh(text)
        }
        super::http::EtagGetOutcome::NotModified => match cached {
            Some(p) => RestLoad::Fresh(p),
            None => RestLoad::Missing,
        },
        _ => match cached {
            Some(p) => RestLoad::Cached(p),
            None => RestLoad::Missing,
        },
    }
}

/// 未登录读取：匿名 REST（ETag 条件缓存），失败回退旧载荷（`is_stale`）或降级空壳；
/// 附带 `authoritative_upvotes` 元标记，供持久化层保护原生顶帖数。
pub async fn fetch_discussion_anonymous(
    db: &Mutex<Database>,
    client: &reqwest::Client,
    api_base: Option<&str>,
    owner: &str,
    repo: &str,
    number: u64,
    force_refresh: bool,
) -> (LaunchpadDiscussionDetail, bool) {
    let d_url = rest_discussion_url(owner, repo, number);
    let (d_text, mut stale) = match rest_get_cached(db, client, api_base, &d_url, force_refresh).await
    {
        RestLoad::Fresh(t) => (t, false),
        RestLoad::Cached(t) => (t, true),
        RestLoad::Missing => return (degraded_shell(owner, repo, number), false),
    };
    let c_url = rest_comments_url(owner, repo, number);
    let c_text = match rest_get_cached(db, client, api_base, &c_url, force_refresh).await {
        RestLoad::Fresh(t) => Some(t),
        RestLoad::Cached(t) => {
            stale = true;
            Some(t)
        }
        RestLoad::Missing => {
            stale = true;
            None
        }
    };
    match parse_rest_discussion(owner, repo, number, &d_text, c_text.as_deref()) {
        Ok((mut detail, authoritative_upvotes)) => {
            detail.is_stale = stale;
            (detail, authoritative_upvotes)
        }
        Err(_) => (degraded_shell(owner, repo, number), false),
    }
}

/// 解析讨论节点 ID（并带回锁帖与可顶帖状态）。
async fn resolve_discussion_node(
    ctx: DiscussionClient<'_>,
    target: DiscussionRef<'_>,
) -> Result<(String, bool, bool), GqlError> {
    let data = graphql_post(
        ctx,
        DISCUSSION_ID_QUERY,
        json!({ "owner": target.owner, "repo": target.repo, "number": target.number }),
        "launchpad_discussion_id",
    )
    .await?;
    let d = data
        .get("repository")
        .and_then(|r| r.get("discussion"))
        .filter(|d| d.is_object())
        .ok_or_else(|| GqlError::Other("讨论不存在或无权访问".to_string()))?;
    let id = str_field(d, "id");
    if id.is_empty() {
        return Err(GqlError::Other("讨论不存在或无权访问".to_string()));
    }
    Ok((id, bool_field(d, "locked"), bool_field(d, "viewerCanUpvote")))
}

/// 校验评论正文：去首尾空白后非空且不超过 `COMMENT_MAX_CHARS` 字符。
pub fn validate_comment_body(body: &str) -> Result<String, String> {
    let t = body.trim();
    if t.is_empty() {
        return Err("评论内容不能为空".to_string());
    }
    if t.chars().count() > COMMENT_MAX_CHARS {
        return Err(format!("评论内容不能超过 {} 个字符", COMMENT_MAX_CHARS));
    }
    Ok(t.to_string())
}

fn non_empty_id(v: Option<&str>) -> Option<String> {
    v.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 发表评论或回复（缺 `discussion_id` 时先查节点 ID 并检查锁帖）。
pub async fn add_comment(
    ctx: DiscussionClient<'_>,
    target: DiscussionRef<'_>,
    discussion_id: Option<&str>,
    body: &str,
    reply_to_id: Option<&str>,
) -> Result<LaunchpadDiscussionComment, String> {
    let body = validate_comment_body(body)?;
    let discussion_id = match non_empty_id(discussion_id) {
        Some(id) => id,
        None => {
            let (id, locked, _) = resolve_discussion_node(ctx, target)
                .await
                .map_err(GqlError::into_message)?;
            if locked {
                return Err("该讨论已被维护者锁定，无法发表评论".to_string());
            }
            id
        }
    };
    let data = graphql_post(
        ctx,
        ADD_COMMENT_MUTATION,
        json!({
            "discussionId": discussion_id,
            "body": body,
            "replyToId": non_empty_id(reply_to_id),
        }),
        "launchpad_add_comment",
    )
    .await
    .map_err(GqlError::into_message)?;
    parse_added_comment(&data)
}

async fn vote_once(
    ctx: DiscussionClient<'_>,
    subject_id: &str,
    currently_upvoted: bool,
    mode: LaunchpadVoteMode,
) -> Result<LaunchpadUpvoteResult, GqlError> {
    let (query, mutation, variables) = match (mode, currently_upvoted) {
        (LaunchpadVoteMode::Reaction, false) => (
            ADD_REACTION_MUTATION,
            "addReaction",
            json!({ "subjectId": subject_id, "content": "THUMBS_UP" }),
        ),
        (LaunchpadVoteMode::Reaction, true) => (
            REMOVE_REACTION_MUTATION,
            "removeReaction",
            json!({ "subjectId": subject_id, "content": "THUMBS_UP" }),
        ),
        (LaunchpadVoteMode::Upvote, false) => (
            ADD_UPVOTE_MUTATION,
            "addUpvote",
            json!({ "subjectId": subject_id }),
        ),
        (LaunchpadVoteMode::Upvote, true) => (
            REMOVE_UPVOTE_MUTATION,
            "removeUpvote",
            json!({ "subjectId": subject_id }),
        ),
    };
    let data = graphql_post(ctx, query, variables, "launchpad_vote").await?;
    parse_vote_result(&data, mutation, mode).map_err(GqlError::Other)
}

/// 双模顶帖：优先原生 `addUpvote`/`removeUpvote`；预检 `viewerCanUpvote == false`
/// 或变更返回 `FORBIDDEN` / 分类不支持投票时回退 👍 Reaction。
pub async fn toggle_upvote(
    ctx: DiscussionClient<'_>,
    target: DiscussionRef<'_>,
    subject_id: Option<&str>,
    currently_upvoted: bool,
) -> Result<LaunchpadUpvoteResult, String> {
    let (subject, can_upvote) = match non_empty_id(subject_id) {
        Some(id) => (id, true),
        None => {
            let (id, _, can) = resolve_discussion_node(ctx, target)
                .await
                .map_err(GqlError::into_message)?;
            (id, can)
        }
    };
    if can_upvote {
        match vote_once(ctx, &subject, currently_upvoted, LaunchpadVoteMode::Upvote).await {
            Ok(r) => return Ok(r),
            Err(GqlError::Forbidden(_) | GqlError::UpvoteUnavailable(_)) => {}
            Err(e) => return Err(e.into_message()),
        }
    }
    vote_once(ctx, &subject, currently_upvoted, LaunchpadVoteMode::Reaction)
        .await
        .map_err(GqlError::into_message)
}

/// 校验评论节点 ID：仅接受 `DC_` 前缀的 GraphQL 节点 ID（防止误把讨论主帖或任意节点当评论投票）。
pub fn validate_comment_node_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    let well_formed = id.len() > 3
        && id.len() <= 128
        && id.starts_with("DC_")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !well_formed {
        return Err("无效的评论 ID".to_string());
    }
    Ok(id.to_string())
}

/// 校验讨论或评论节点 ID：仅接受 `D_` / `DC_` 前缀的非空 GraphQL 节点 ID。
pub fn validate_discussion_subject_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    let body = id.strip_prefix("DC_").or_else(|| id.strip_prefix("D_"));
    let well_formed = body.is_some_and(|rest| !rest.is_empty())
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !well_formed {
        return Err("无效的讨论或评论 ID".to_string());
    }
    Ok(id.to_string())
}

/// 校验 GitHub `ReactionContent` 枚举值。
pub fn validate_reaction_content(raw: &str) -> Result<String, String> {
    let norm = raw.trim().to_ascii_uppercase();
    if !ALLOWED_REACTION_CONTENTS.contains(&norm.as_str()) {
        return Err("不支持的表情类型".to_string());
    }
    Ok(norm)
}

/// 切换讨论主帖或评论（含二级回复）的 Emoji Reaction。
pub async fn toggle_reaction(
    ctx: DiscussionClient<'_>,
    subject_id: &str,
    content: &str,
    currently_reacted: bool,
) -> Result<Vec<LaunchpadReactionGroup>, String> {
    let id = validate_discussion_subject_id(subject_id)?;
    let content = validate_reaction_content(content)?;
    let (query, mutation) = if currently_reacted {
        (REMOVE_REACTION_MUTATION, "removeReaction")
    } else {
        (ADD_REACTION_MUTATION, "addReaction")
    };
    let data = graphql_post(
        ctx,
        query,
        json!({ "subjectId": id, "content": content }),
        "launchpad_reaction",
    )
    .await
    .map_err(GqlError::into_message)?;
    let subject = data
        .get(mutation)
        .and_then(|r| r.get("subject"))
        .filter(|s| s.is_object())
        .ok_or_else(|| "表情回应失败：响应缺少目标实体".to_string())?;
    Ok(gql_reaction_groups(subject))
}

/// 评论顶帖 / 取消顶帖：仅走原生 `addUpvote`/`removeUpvote`（评论计数只读原生 `upvoteCount`，
/// 不回退 👍 Reaction，避免写入与展示口径不一致）。
pub async fn toggle_comment_upvote(
    ctx: DiscussionClient<'_>,
    comment_id: &str,
    currently_upvoted: bool,
) -> Result<LaunchpadUpvoteResult, String> {
    let id = validate_comment_node_id(comment_id)?;
    vote_once(ctx, &id, currently_upvoted, LaunchpadVoteMode::Upvote)
        .await
        .map_err(GqlError::into_message)
}

/// 单次批量 GraphQL 脉冲查询条数上限（与数据仓 `refresh-pulse-and-pins` 同档）。
pub const PULSE_GRAPHQL_BATCH: usize = 25;
/// 未登录匿名脉冲刷新保鲜窗口（秒），保护 60/h 匿名配额。
pub const ANON_PULSE_FRESH_SECS: i64 = 300;
/// 未登录单轮最多条件请求的讨论数。
pub const ANON_PULSE_MAX_ITEMS: usize = 20;
/// 未登录脉冲并发上限（D6 有限并发）。
const ANON_PULSE_CONCURRENCY: usize = 4;

/// 广场卡片实时脉冲查询目标。
#[derive(Debug, Clone)]
pub struct PulseTarget {
    pub id: String,
    pub owner: String,
    pub repo: String,
    pub is_github: bool,
    pub discussion_repo: String,
    pub discussion_number: u64,
}

/// 广场卡片从 GitHub Discussions（及同批源仓库）拉回的最新脉冲结果。
#[derive(Debug, Clone)]
pub struct PulseFetched {
    pub target: PulseTarget,
    pub node_id: Option<String>,
    pub upvote_count: u64,
    pub authoritative_upvotes: bool,
    pub comments_count: Option<u64>,
    pub viewer_has_upvoted: Option<bool>,
    pub stars: Option<u64>,
    pub forks: Option<u64>,
    pub latest_version: Option<String>,
    pub viewer_has_starred: Option<bool>,
}

async fn graphql_post_allow_partial(
    ctx: DiscussionClient<'_>,
    query: &str,
    variables: Value,
    op: &str,
) -> Result<Value, GqlError> {
    let body = graphql_post_raw(ctx, query, variables, op).await?;
    if let Some(errors) = body.get("errors").and_then(|e| e.as_array()) {
        if errors.iter().any(|e| {
            e.get("type").and_then(|t| t.as_str()) == Some("INSUFFICIENT_SCOPES")
        }) {
            return Err(GqlError::InsufficientScopes);
        }
    }
    if let Some(data) = body.get("data").filter(|d| d.is_object()) {
        return Ok(data.clone());
    }
    map_graphql_response(&body).cloned()
}

/// 已登录批量刷新：每批至多 25 个条目经单次参数化别名 GraphQL 取回讨论最新顶帖数、
/// 本人顶帖态、含二级回复的评论总数，以及 GitHub 源仓星数/版本/标星态。
pub async fn fetch_pulse_batch_authed(
    ctx: DiscussionClient<'_>,
    targets: &[PulseTarget],
) -> Result<Vec<PulseFetched>, GqlError> {
    let mut out = Vec::new();
    for chunk in targets.chunks(PULSE_GRAPHQL_BATCH) {
        let mut defs: Vec<String> = Vec::new();
        let mut fields: Vec<String> = Vec::new();
        let mut vars = serde_json::Map::new();
        let mut active: Vec<(usize, &PulseTarget, bool, bool)> = Vec::new();

        for (i, t) in chunk.iter().enumerate() {
            let disc_coord = (t.discussion_number > 0)
                .then(|| validate_discussion_repo(&t.discussion_repo).ok())
                .flatten()
                .and_then(|(o, r)| validate_discussion_number(t.discussion_number).ok().map(|n| (o, r, n)));
            let repo_coord = t
                .is_github
                .then(|| validate_discussion_repo(&format!("{}/{}", t.owner, t.repo)).ok())
                .flatten();

            if disc_coord.is_none() && repo_coord.is_none() {
                continue;
            }
            if let Some((d_owner, d_repo, d_num)) = &disc_coord {
                defs.push(format!("$do{i}: String!"));
                defs.push(format!("$dn{i}: String!"));
                defs.push(format!("$d{i}n: Int!"));
                vars.insert(format!("do{i}"), Value::String(d_owner.clone()));
                vars.insert(format!("dn{i}"), Value::String(d_repo.clone()));
                vars.insert(format!("d{i}n"), Value::from(*d_num));
                fields.push(format!(
                    "d{i}: repository(owner: $do{i}, name: $dn{i}) {{ \
                        discussion(number: $d{i}n) {{ \
                            id upvoteCount viewerCanUpvote viewerHasUpvoted \
                            reactionGroups {{ content viewerHasReacted reactors {{ totalCount }} }} \
                            comments(first: 100) {{ totalCount nodes {{ replies {{ totalCount }} }} }} \
                        }} \
                    }}"
                ));
            }
            if let Some((r_owner, r_repo)) = &repo_coord {
                defs.push(format!("$ro{i}: String!"));
                defs.push(format!("$rn{i}: String!"));
                vars.insert(format!("ro{i}"), Value::String(r_owner.clone()));
                vars.insert(format!("rn{i}"), Value::String(r_repo.clone()));
                fields.push(format!(
                    "r{i}: repository(owner: $ro{i}, name: $rn{i}) {{ \
                        stargazerCount forkCount viewerHasStarred latestRelease {{ tagName }} \
                    }}"
                ));
            }
            active.push((i, t, disc_coord.is_some(), repo_coord.is_some()));
        }

        if active.is_empty() {
            continue;
        }
        let query = format!("query({}) {{ {} }}", defs.join(", "), fields.join(" "));
        let data = graphql_post_allow_partial(
            ctx,
            &query,
            Value::Object(vars),
            "launchpad_pulse_batch",
        )
        .await?;

        for (i, t, has_disc, has_repo) in active {
            let disc_val = has_disc
                .then(|| data.get(format!("d{i}")).and_then(|r| r.get("discussion")))
                .flatten()
                .filter(|v| v.is_object());
            let repo_val = has_repo
                .then(|| data.get(format!("r{i}")))
                .flatten()
                .filter(|v| v.is_object());
            if disc_val.is_none() && repo_val.is_none() {
                continue;
            }
            let (node_id, upvote_count, comments_count, viewer_has_upvoted) = match disc_val {
                Some(d) => {
                    let can_upvote = bool_field(d, "viewerCanUpvote");
                    let (up, mine) = if can_upvote {
                        (u64_field(d, "upvoteCount"), bool_field(d, "viewerHasUpvoted"))
                    } else {
                        thumbs_up(d)
                    };
                    let comments = d.get("comments").cloned().unwrap_or(Value::Null);
                    let replies_sum = sum_reply_totals(&comments);
                    let id = str_field(d, "id");
                    (
                        (!id.is_empty()).then_some(id),
                        up,
                        Some(u64_field(&comments, "totalCount").saturating_add(replies_sum)),
                        Some(mine),
                    )
                }
                None => (None, 0, None, None),
            };
            let stars = repo_val.map(|r| u64_field(r, "stargazerCount"));
            let forks = repo_val.map(|r| u64_field(r, "forkCount"));
            let viewer_has_starred = repo_val.map(|r| bool_field(r, "viewerHasStarred"));
            let latest_version = repo_val
                .and_then(|r| r.get("latestRelease"))
                .filter(|rel| rel.is_object())
                .map(|rel| str_field(rel, "tagName"))
                .filter(|v| !v.trim().is_empty());

            out.push(PulseFetched {
                target: t.clone(),
                node_id,
                upvote_count,
                authoritative_upvotes: disc_val.is_some(),
                comments_count,
                viewer_has_upvoted,
                stars,
                forks,
                latest_version,
                viewer_has_starred,
            });
        }
    }
    Ok(out)
}

/// 未登录只读脉冲刷新：走 `api_etag_cache` 条件缓存（`304` 零配额消耗），`buffer_unordered(4)` 有界并发。
pub async fn fetch_pulse_anonymous(
    db: &Mutex<Database>,
    client: &reqwest::Client,
    api_base: Option<&str>,
    targets: &[PulseTarget],
    existing: &std::collections::HashMap<(String, u64), crate::db::LaunchpadDiscussionState>,
    force_refresh: bool,
    now: i64,
) -> Vec<PulseFetched> {
    use futures_util::stream::{self, StreamExt};

    let mut jobs: Vec<(PulseTarget, String, String, u64)> = Vec::new();
    for t in targets {
        if t.discussion_number == 0 {
            continue;
        }
        let Ok((d_owner, d_repo)) = validate_discussion_repo(&t.discussion_repo) else {
            continue;
        };
        let Ok(d_num) = validate_discussion_number(t.discussion_number) else {
            continue;
        };
        let key = (format!("{d_owner}/{d_repo}"), d_num);
        if !force_refresh {
            if let Some(st) = existing.get(&key) {
                if now.saturating_sub(st.synced_at) < ANON_PULSE_FRESH_SECS {
                    continue;
                }
            }
        }
        jobs.push((t.clone(), d_owner, d_repo, d_num));
        if jobs.len() >= ANON_PULSE_MAX_ITEMS {
            break;
        }
    }

    let results: Vec<Option<PulseFetched>> = stream::iter(jobs)
        .map(|(target, owner, repo, number)| async move {
            let d_url = rest_discussion_url(&owner, &repo, number);
            let RestLoad::Fresh(d_text) =
                rest_get_cached(db, client, api_base, &d_url, force_refresh).await
            else {
                return None;
            };
            let Ok((detail, authoritative_upvotes)) =
                parse_rest_discussion(&owner, &repo, number, &d_text, None)
            else {
                return None;
            };
            if detail.id.is_empty() && detail.title.is_empty() {
                return None;
            }
            Some(PulseFetched {
                target,
                node_id: (!detail.id.is_empty()).then_some(detail.id),
                upvote_count: detail.upvote_count,
                authoritative_upvotes,
                comments_count: Some(detail.comments_total),
                viewer_has_upvoted: None,
                stars: None,
                forks: None,
                latest_version: None,
                viewer_has_starred: None,
            })
        })
        .buffer_unordered(ANON_PULSE_CONCURRENCY)
        .collect()
        .await;
    let total = results.len();
    let ok: Vec<PulseFetched> = results.into_iter().flatten().collect();
    if ok.len() < total {
        log::debug!(
            target: "launchpad",
            "anonymous discussion pulse partial: ok={} skipped_or_failed={}",
            ok.len(),
            total - ok.len()
        );
    }
    ok
}

#[cfg(test)]
#[path = "discussions_tests.rs"]
mod tests;
