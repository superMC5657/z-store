use super::{AddToListOutcome, OAuthUser, StarRepoOutcome, GITHUB_API_BASE};
use serde::Deserialize;

/// Star API 地址构造（纯函数，对 owner/repo 做 percent-encoding 防止路径穿越）。
pub fn starred_api_url(owner: &str, repo: &str) -> String {
    format!(
        "{}/user/starred/{}/{}",
        GITHUB_API_BASE,
        urlencoding::encode(owner.trim()),
        urlencoding::encode(repo.trim())
    )
}

/// 校验 GitHub Star 接口的 `(owner, repo)` 段，拒绝 `.`、`..`、控制字符与路径/查询注入符。
fn validate_github_repo_parts<'a>(
    owner: &'a str,
    repo: &'a str,
) -> Result<(&'a str, &'a str), String> {
    let o = owner.trim();
    let r = repo.trim();
    if !crate::forge::coord::is_valid_repo_segment(o)
        || !crate::forge::coord::is_valid_repo_segment(r)
    {
        return Err(format!("无效的 GitHub 仓库坐标: {}/{}", owner, repo));
    }
    Ok((o, r))
}

/// 构建 GitHub API 客户端（认证按请求经 auth_headers 携带，永不落日志）。
fn authed_client() -> Result<reqwest::Client, String> {
    Ok(crate::shared_http_client())
}

pub(super) fn auth_headers(token: &str) -> Result<reqwest::header::HeaderMap, String> {
    // 非法 header 字符返回 Err（`forge::http` 侧为静默跳过，此处错误文案更明确）。
    if reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.trim())).is_err() {
        return Err("认证令牌格式无效".to_string());
    }
    Ok(crate::forge::http::api_headers(
        crate::forge::http::GITHUB_ACCEPT_VALUE,
        Some(token),
        crate::forge::http::AuthScheme::Bearer,
    ))
}

/// GraphQL 单条错误是否为权限不足（`INSUFFICIENT_SCOPES`）。
fn is_insufficient_scopes(err: &serde_json::Value) -> bool {
    err.get("type").and_then(|t| t.as_str()) == Some("INSUFFICIENT_SCOPES")
}

/// 拉取当前令牌对应的 GitHub 用户（`login` + `avatar_url` + `has_list_scope`）。
pub async fn fetch_oauth_user(token: &str) -> Result<OAuthUser, String> {
    let client = authed_client()?;
    let resp = client
        .get(format!("{}/user", GITHUB_API_BASE))
        .headers(auth_headers(token)?)
        .send()
        .await
        .map_err(|e| format!("获取 GitHub 用户信息失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    let has_list_scope = resp
        .headers()
        .get("x-oauth-scopes")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').any(|part| part.trim() == "user"))
        .unwrap_or(false);
    if crate::check_auth_expired(resp.status().as_u16(), "op=fetch_user") {
        // 401 warn：只记结论与操作，不记 token / body。
        return Err("GitHub 授权已失效 (401)，请重新登录".to_string());
    }
    if !resp.status().is_success() {
        if resp.status().as_u16() == 403 {
            let mut ev = crate::z_log::WideEvent::new("oauth", "forbidden");
            ev.field("status", 403).dev("op", "fetch_user");
            ev.warn();
        }
        return Err(format!(
            "获取 GitHub 用户信息失败，HTTP 状态码: {}",
            resp.status()
        ));
    }
    #[derive(Deserialize)]
    struct UserBody {
        login: String,
        #[serde(default)]
        avatar_url: Option<String>,
    }
    let body: UserBody = resp
        .json()
        .await
        .map_err(|e| format!("解析用户信息失败: {}", e))?;
    Ok(OAuthUser {
        login: body.login.clone(),
        avatar_url: body
            .avatar_url
            .unwrap_or_else(|| format!("https://github.com/{}.png", body.login)),
        has_list_scope,
        is_expired: false,
    })
}

/// 查询是否已 Star（204 = 已 Star，404 = 未 Star）。
pub async fn check_starred(token: &str, owner: &str, repo: &str) -> Result<bool, String> {
    let (owner, repo) = validate_github_repo_parts(owner, repo)?;
    let resp = super::authed_req(
        reqwest::Method::GET,
        &starred_api_url(owner, repo),
        token,
        None,
        "查询 Star 状态失败",
    )
    .await?;
    match resp.status().as_u16() {
        204 => Ok(true),
        404 => Ok(false),
        code => {
            let op_ctx = format!("op=check_starred owner={} repo={}", owner, repo);
            super::map_auth_status(
                code,
                &op_ctx,
                "GitHub 授权已失效 (401)，请重新登录",
                "GitHub API 限额已耗尽 (403)，请稍后重试",
            )?;
            Err(format!("查询 Star 状态失败，HTTP 状态码: {}", code))
        }
    }
}

/// Star 指定仓库（幂等，PUT 成功返回 204）。
/// 并自动尝试将仓库归入 GitHub User List（z-store-list 列表）。
pub async fn star_repo(token: &str, owner: &str, repo: &str) -> Result<StarRepoOutcome, String> {
    let (owner, repo) = validate_github_repo_parts(owner, repo)?;
    let resp = super::authed_req(
        reqwest::Method::PUT,
        &starred_api_url(owner, repo),
        token,
        None,
        "Star 失败",
    )
    .await?;
    if resp.status().is_success() {
        // 自动同步归入 GitHub User List（z-store-list）
        let list_outcome = add_repo_to_star_list(token, owner, repo).await;
        match list_outcome {
            Ok(AddToListOutcome::Success) => Ok(StarRepoOutcome {
                starred: true,
                in_list: true,
                warning: None,
            }),
            Ok(AddToListOutcome::InsufficientScopes) => Ok(StarRepoOutcome {
                starred: true,
                in_list: false,
                warning: Some("已在 GitHub 标星！但检测到当前登录凭据缺少「user」权限，未能归入 z-store-list 列表。请在「设置」中重新登录 GitHub 账号以授权新权限。".to_string()),
            }),
            Ok(AddToListOutcome::OrgRestricted(org)) => Ok(StarRepoOutcome {
                starred: true,
                in_list: false,
                warning: Some(format!(
                    "已在 GitHub 成功标星！但该仓库属于组织「{}」，组织开启了第三方 OAuth 访问限制，GitHub 拒绝第三方应用将其写入清单，该仓库暂无法归入清单。",
                    org
                )),
            }),
            Ok(AddToListOutcome::Failed(msg)) => Ok(StarRepoOutcome {
                starred: true,
                in_list: false,
                warning: Some(format!("已在 GitHub 标星，列表同步提示: {}", msg)),
            }),
            Err(e) => Ok(StarRepoOutcome {
                starred: true,
                in_list: false,
                warning: Some(format!("已在 GitHub 标星，列表同步异常: {}", e)),
            }),
        }
    } else {
        let code = resp.status().as_u16();
        let op_ctx = format!("op=star owner={} repo={}", owner, repo);
        super::map_auth_status(
            code,
            &op_ctx,
            "GitHub 授权已失效 (401)，请重新登录",
            "Star 失败 (403)：令牌缺少 public_repo 权限或 API 限额已耗尽",
        )?;
        Err(format!("Star 失败，HTTP 状态码: {}", resp.status()))
    }
}

/// Star List 分页上限：防止异常游标死循环；若超过上限仍未翻完，必须安全中止而非覆盖。
const MAX_STAR_LIST_PAGES: usize = 20;
const MAX_STAR_LIST_ITEM_PAGES: usize = 50;

const ABORT_INCOMPLETE_LISTS_MSG: &str =
    "无法完整读取现有 Star 列表分页，已中止列表同步以避免覆盖既有分组";

/// 解析 GraphQL `pageInfo`：`hasNextPage` 必须存在；为真时 `endCursor` 必须非空，否则视为分页不完整。
fn parse_page_info(page_info: Option<&serde_json::Value>) -> Result<Option<String>, ()> {
    let pi = page_info.ok_or(())?;
    let has_next = pi.get("hasNextPage").and_then(|v| v.as_bool()).ok_or(())?;
    if !has_next {
        return Ok(None);
    }
    let cursor = pi
        .get("endCursor")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(())?;
    Ok(Some(cursor.to_string()))
}

/// 发送单次 GraphQL 请求并解析响应 JSON；非 2xx 与 `INSUFFICIENT_SCOPES` 归一为 `AddToListOutcome`。
async fn post_star_list_graphql(
    client: &reqwest::Client,
    gql_url: &str,
    headers: &reqwest::header::HeaderMap,
    payload: &serde_json::Value,
    op_label: &str,
) -> Result<Result<serde_json::Value, AddToListOutcome>, String> {
    let resp = client
        .post(gql_url)
        .headers(headers.clone())
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("{}: {}", op_label, e))?;
    if !resp.status().is_success() {
        return Ok(Err(AddToListOutcome::Failed(format!(
            "{} HTTP 状态码: {}",
            op_label,
            resp.status()
        ))));
    }
    let val: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析{}响应失败: {}", op_label, e))?;
    if let Some(errs) = val.get("errors").and_then(|e| e.as_array()) {
        for err in errs {
            if is_insufficient_scopes(err) {
                return Ok(Err(AddToListOutcome::InsufficientScopes));
            }
        }
    }
    Ok(Ok(val))
}

fn nodes_contain_repo(nodes: &[serde_json::Value], repo_id: &str) -> bool {
    nodes
        .iter()
        .any(|it| it.get("id").and_then(|v| v.as_str()) == Some(repo_id))
}

/// 将已 Star 的仓库归入 GitHub User List（默认列表名：z-store-list）。
/// 若当前令牌缺少 `user` scope 或 GraphQL 返回权限错误，返回 InsufficientScopes，保证调用方获得准确反馈。
/// 完整翻页所有 `lists` 与每张列表的 `items`；若任一分页未读完或异常，安全中止写入而不覆盖既有归属。
pub async fn add_repo_to_star_list(
    token: &str,
    owner: &str,
    repo: &str,
) -> Result<AddToListOutcome, String> {
    add_repo_to_star_list_with_base(token, owner, repo, GITHUB_API_BASE).await
}

pub(crate) async fn add_repo_to_star_list_with_base(
    token: &str,
    owner: &str,
    repo: &str,
    api_base: &str,
) -> Result<AddToListOutcome, String> {
    let (owner, repo) = validate_github_repo_parts(owner, repo)?;
    let client = authed_client()?;
    let headers = auth_headers(token)?;
    let gql_url = format!("{}/graphql", api_base.trim_end_matches('/'));

    // 1. 完整分页拉取 viewer.lists（首请求同时取目标仓库 node id）
    let first_page_query = r#"
        query($owner: String!, $name: String!, $listsAfter: String) {
          viewer {
            lists(first: 50, after: $listsAfter) {
              nodes {
                id
                name
                items(first: 100) {
                  nodes {
                    __typename
                    ... on Repository {
                      id
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          repository(owner: $owner, name: $name) {
            id
          }
        }
    "#;
    let next_lists_query = r#"
        query($listsAfter: String!) {
          viewer {
            lists(first: 50, after: $listsAfter) {
              nodes {
                id
                name
                items(first: 100) {
                  nodes {
                    __typename
                    ... on Repository {
                      id
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
    "#;

    let mut repo_id: Option<String> = None;
    let mut target_list_id: Option<String> = None;
    let mut item_list_ids: Vec<String> = Vec::new();
    let mut lists_needing_item_pages: Vec<(String, String)> = Vec::new();
    let mut lists_cursor: Option<String> = None;
    let mut list_pages_fetched: usize = 0;

    loop {
        list_pages_fetched += 1;
        let payload = if lists_cursor.is_none() {
            serde_json::json!({
                "query": first_page_query,
                "variables": {
                    "owner": owner,
                    "name": repo,
                    "listsAfter": serde_json::Value::Null
                }
            })
        } else {
            serde_json::json!({
                "query": next_lists_query,
                "variables": {
                    "listsAfter": lists_cursor
                }
            })
        };

        let val =
            match post_star_list_graphql(&client, &gql_url, &headers, &payload, "GraphQL 列表查询")
                .await?
            {
                Ok(v) => v,
                Err(outcome) => return Ok(outcome),
            };

        if val
            .get("errors")
            .and_then(|e| e.as_array())
            .is_some_and(|arr| !arr.is_empty())
        {
            return Ok(AddToListOutcome::Failed(
                ABORT_INCOMPLETE_LISTS_MSG.to_string(),
            ));
        }

        if repo_id.is_none() {
            repo_id = val
                .pointer("/data/repository/id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            if repo_id.is_none() {
                return Ok(AddToListOutcome::Failed("未找到对应仓库 ID".to_string()));
            }
        }
        let current_repo_id = repo_id.as_deref().unwrap_or_default();

        let Some(lists_conn) = val.pointer("/data/viewer/lists") else {
            return Ok(AddToListOutcome::Failed(
                ABORT_INCOMPLETE_LISTS_MSG.to_string(),
            ));
        };
        let Some(nodes) = lists_conn.get("nodes").and_then(|v| v.as_array()) else {
            return Ok(AddToListOutcome::Failed(
                ABORT_INCOMPLETE_LISTS_MSG.to_string(),
            ));
        };

        for n in nodes {
            let id = n.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            }
            let name = n.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let lower = name.trim().to_lowercase();
            if lower == "z-store-list" || lower == "star-list" {
                target_list_id = Some(id.to_string());
            }
            let Some(items_conn) = n.get("items") else {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            };
            let Some(items) = items_conn.get("nodes").and_then(|v| v.as_array()) else {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            };
            if nodes_contain_repo(items, current_repo_id) {
                if !item_list_ids.iter().any(|existing| existing == id) {
                    item_list_ids.push(id.to_string());
                }
            } else {
                match parse_page_info(items_conn.get("pageInfo")) {
                    Ok(Some(next_item_cursor)) => {
                        lists_needing_item_pages.push((id.to_string(), next_item_cursor));
                    }
                    Ok(None) => {}
                    Err(()) => {
                        return Ok(AddToListOutcome::Failed(
                            ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                        ));
                    }
                }
            }
        }

        match parse_page_info(lists_conn.get("pageInfo")) {
            Ok(Some(next_cursor)) => {
                if list_pages_fetched >= MAX_STAR_LIST_PAGES {
                    return Ok(AddToListOutcome::Failed(
                        ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                    ));
                }
                lists_cursor = Some(next_cursor);
            }
            Ok(None) => break,
            Err(()) => {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            }
        }
    }

    let repo_id = repo_id.unwrap_or_default();

    // 若目标列表已包含当前仓库，无需调用 updateUserListsForItem（零覆盖风险）。
    if let Some(ref tid) = target_list_id {
        if item_list_ids.iter().any(|existing| existing == tid) {
            return Ok(AddToListOutcome::Success);
        }
    }

    // 2. 对首屏未命中且存在后续页的列表逐一完整翻页（优先检查目标列表，命中可提前结束）
    if let Some(ref tid) = target_list_id {
        if let Some(pos) = lists_needing_item_pages
            .iter()
            .position(|(lid, _)| lid == tid)
        {
            if pos > 0 {
                let entry = lists_needing_item_pages.remove(pos);
                lists_needing_item_pages.insert(0, entry);
            }
        }
    }

    let list_items_query = r#"
        query($listId: ID!, $after: String!) {
          node(id: $listId) {
            ... on UserList {
              items(first: 100, after: $after) {
                nodes {
                  __typename
                  ... on Repository {
                    id
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
    "#;

    for (list_id, mut item_cursor) in lists_needing_item_pages {
        let mut item_pages_fetched: usize = 1; // 首屏已拉第 1 页
        loop {
            if item_pages_fetched >= MAX_STAR_LIST_ITEM_PAGES {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            }
            item_pages_fetched += 1;
            let payload = serde_json::json!({
                "query": list_items_query,
                "variables": {
                    "listId": list_id,
                    "after": item_cursor
                }
            });
            let val = match post_star_list_graphql(
                &client,
                &gql_url,
                &headers,
                &payload,
                "GraphQL 列表项分页查询",
            )
            .await?
            {
                Ok(v) => v,
                Err(outcome) => return Ok(outcome),
            };
            if val
                .get("errors")
                .and_then(|e| e.as_array())
                .is_some_and(|arr| !arr.is_empty())
            {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            }
            let Some(items_conn) = val.pointer("/data/node/items") else {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            };
            let Some(items) = items_conn.get("nodes").and_then(|v| v.as_array()) else {
                return Ok(AddToListOutcome::Failed(
                    ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                ));
            };
            if nodes_contain_repo(items, &repo_id) {
                if !item_list_ids.iter().any(|existing| existing == &list_id) {
                    item_list_ids.push(list_id.clone());
                }
                if target_list_id.as_deref() == Some(list_id.as_str()) {
                    return Ok(AddToListOutcome::Success);
                }
                break;
            }
            match parse_page_info(items_conn.get("pageInfo")) {
                Ok(Some(next_cursor)) => {
                    item_cursor = next_cursor;
                }
                Ok(None) => break,
                Err(()) => {
                    return Ok(AddToListOutcome::Failed(
                        ABORT_INCOMPLETE_LISTS_MSG.to_string(),
                    ));
                }
            }
        }
    }

    // 若列表不存在，则尝试通过 GraphQL 创建 z-store-list
    let target_list_id = match target_list_id {
        Some(id) => id,
        None => {
            let create_mutation = r#"
                mutation {
                  createUserList(input: { name: "z-store-list", description: "ZStore 标星应用清单 (Star List)" }) {
                    list {
                      id
                      name
                    }
                  }
                }
            "#;
            let create_payload = serde_json::json!({ "query": create_mutation });
            let create_val = match post_star_list_graphql(
                &client,
                &gql_url,
                &headers,
                &create_payload,
                "创建列表",
            )
            .await?
            {
                Ok(v) => v,
                Err(outcome) => return Ok(outcome),
            };

            match create_val
                .pointer("/data/createUserList/list/id")
                .and_then(|v| v.as_str())
            {
                Some(id) => id.to_string(),
                None => {
                    return Ok(AddToListOutcome::Failed("未能获取新建列表 ID".to_string()));
                }
            }
        }
    };

    if !item_list_ids.contains(&target_list_id) {
        item_list_ids.push(target_list_id);
    }

    // 3. 将仓库更新到完整保留的列表集合中
    let add_mutation = r#"
        mutation($itemId: ID!, $listIds: [ID!]!) {
          updateUserListsForItem(input: { itemId: $itemId, listIds: $listIds }) {
            clientMutationId
          }
        }
    "#;
    let add_payload = serde_json::json!({
        "query": add_mutation,
        "variables": {
            "itemId": repo_id,
            "listIds": item_list_ids
        }
    });

    let add_resp = client
        .post(&gql_url)
        .headers(headers)
        .json(&add_payload)
        .send()
        .await
        .map_err(|e| format!("更新列表项失败: {}", e))?;

    if !add_resp.status().is_success() {
        return Ok(AddToListOutcome::Failed(format!(
            "更新列表 HTTP 状态码: {}",
            add_resp.status()
        )));
    }

    let add_val: serde_json::Value = add_resp
        .json()
        .await
        .map_err(|e| format!("解析更新列表响应失败: {}", e))?;

    if let Some(errs) = add_val.get("errors").and_then(|e| e.as_array()) {
        for err in errs {
            let err_type = err.get("type").and_then(|t| t.as_str()).unwrap_or_default();
            let err_msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or_default();
            if is_insufficient_scopes(err) {
                return Ok(AddToListOutcome::InsufficientScopes);
            }
            if err_type == "FORBIDDEN" || err_msg.contains("OAuth App access restrictions") {
                return Ok(AddToListOutcome::OrgRestricted(owner.to_string()));
            }
        }
        return Ok(AddToListOutcome::Failed(format!(
            "GraphQL 错误: {:?}",
            errs
        )));
    }

    Ok(AddToListOutcome::Success)
}

/// 取消 Star（幂等，DELETE 成功返回 204）。
pub async fn unstar_repo(token: &str, owner: &str, repo: &str) -> Result<(), String> {
    let (owner, repo) = validate_github_repo_parts(owner, repo)?;
    let resp = super::authed_req(
        reqwest::Method::DELETE,
        &starred_api_url(owner, repo),
        token,
        None,
        "取消 Star 失败",
    )
    .await?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let code = resp.status().as_u16();
        let status = resp.status();
        let op_ctx = format!("op=unstar owner={} repo={}", owner, repo);
        let forbidden_msg = format!("取消 Star 失败，HTTP 状态码: {}", status);
        super::map_auth_status(
            code,
            &op_ctx,
            "GitHub 授权已失效 (401)，请重新登录",
            &forbidden_msg,
        )?;
        Err(format!("取消 Star 失败，HTTP 状态码: {}", status))
    }
}
