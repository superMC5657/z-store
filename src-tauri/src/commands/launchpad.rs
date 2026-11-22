//! 开源广场（Launchpad）IPC 适配层：参数透传至 `crate::launchpad` 领域接口。

use crate::launchpad::discussion::LaunchpadDiscussions;
use crate::launchpad::{
    LaunchpadDiscussionComment, LaunchpadDiscussionDetail, LaunchpadFeedResponse,
    LaunchpadPreflightResult, LaunchpadPulseItem, LaunchpadReactionGroup, LaunchpadUpvoteResult,
};
use crate::AppState;
use tauri::{AppHandle, State};

fn discussions(state: &AppState) -> LaunchpadDiscussions<'_> {
    LaunchpadDiscussions {
        db: &state.db,
        client: crate::shared_http_client(),
        api_base: crate::github::GITHUB_API_BASE,
        token: state.active_github_token(),
    }
}

/// 开源广场清单：按需拉取（启动阶段不预取），失败降级本地快照；缺图标条目交后台补图。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_launchpad_feed(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> crate::AppResult<LaunchpadFeedResponse> {
    let feed = crate::launchpad::feed::load_feed(&state, force_refresh.unwrap_or(false)).await?;
    let token = state.active_github_token();
    crate::icons::spawn_launchpad_icon_stream(&app_handle, feed.missing_icons, token);
    Ok(feed.response)
}

/// 开源广场实时讨论脉冲：批量拉取顶帖数、评论数、本人顶帖态与源仓星数并落盘。
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_launchpad_discussions(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<LaunchpadPulseItem>> {
    let cfg = &crate::config::get_project_config().launchpad;
    let token = state.active_github_token();
    let items = crate::launchpad::pulse::sync_discussions(
        &state.db,
        &state.catalog,
        &crate::shared_http_client(),
        crate::github::GITHUB_API_BASE,
        cfg.default_source_url.trim(),
        token.as_deref(),
        force_refresh.unwrap_or(false),
    )
    .await
    .inspect_err(|e| {
        let reason = crate::log_support::short_reason(e);
        log::warn!(target: "launchpad", "discussion pulse sync failed: {}", reason);
    })?;
    Ok(items)
}

/// 讨论详情：已登录走 GraphQL；未登录走匿名 REST 只读降级。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_launchpad_discussion(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    cursor: Option<String>,
    force_refresh: Option<bool>,
) -> crate::AppResult<LaunchpadDiscussionDetail> {
    let force = force_refresh.unwrap_or(false);
    discussions(&state)
        .get(
            &discussion_repo,
            discussion_number,
            cursor.as_deref(),
            force,
        )
        .await
        .map_err(Into::into)
}

/// 发表评论或回复（需登录）。
#[tauri::command(rename_all = "camelCase")]
pub async fn add_launchpad_comment(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    discussion_id: Option<String>,
    body: String,
    reply_to_id: Option<String>,
) -> crate::AppResult<LaunchpadDiscussionComment> {
    let (id, reply) = (discussion_id.as_deref(), reply_to_id.as_deref());
    discussions(&state)
        .add_comment(&discussion_repo, discussion_number, id, &body, reply)
        .await
        .map_err(Into::into)
}

/// 主帖 `+1` 顶帖 / 取消顶帖（需登录）。
#[tauri::command(rename_all = "camelCase")]
pub async fn toggle_launchpad_upvote(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    subject_id: Option<String>,
    currently_upvoted: bool,
) -> crate::AppResult<LaunchpadUpvoteResult> {
    let subject = subject_id.as_deref();
    discussions(&state)
        .toggle_upvote(
            &discussion_repo,
            discussion_number,
            subject,
            currently_upvoted,
        )
        .await
        .map_err(Into::into)
}

/// 一级评论 `+1` 顶帖 / 取消顶帖（需登录）。
#[tauri::command(rename_all = "camelCase")]
pub async fn toggle_launchpad_comment_upvote(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    comment_id: String,
    currently_upvoted: bool,
) -> crate::AppResult<LaunchpadUpvoteResult> {
    let (id, upvoted) = (comment_id.as_str(), currently_upvoted);
    discussions(&state)
        .toggle_comment_upvote(&discussion_repo, discussion_number, id, upvoted)
        .await
        .map_err(Into::into)
}

/// 讨论主帖 / 评论（含二级回复）Emoji Reaction 切换（需登录）。
#[tauri::command(rename_all = "camelCase")]
pub async fn toggle_launchpad_reaction(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    subject_id: String,
    content: String,
    currently_reacted: bool,
) -> crate::AppResult<Vec<LaunchpadReactionGroup>> {
    let (subject, reacted) = (subject_id.as_str(), currently_reacted);
    discussions(&state)
        .toggle_reaction(
            &discussion_repo,
            discussion_number,
            subject,
            &content,
            reacted,
        )
        .await
        .map_err(Into::into)
}

/// 开源广场应用内投稿预检（只读）。
#[tauri::command(rename_all = "camelCase")]
pub async fn preflight_launchpad_submission(
    state: State<'_, AppState>,
    repo_url: String,
    custom_icon_url: Option<String>,
) -> crate::AppResult<LaunchpadPreflightResult> {
    let icon = custom_icon_url.as_deref();
    crate::launchpad::preflight::preflight_submission(&state, &repo_url, icon)
        .await
        .map_err(Into::into)
}
