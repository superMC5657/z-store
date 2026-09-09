use super::constants::GITHUB_API_BASE;
use super::types::{AddToListOutcome, OAuthUser, StarRepoOutcome};
use serde::Deserialize;

/// Star API 地址构造（纯函数）。
pub fn starred_api_url(owner: &str, repo: &str) -> String {
    format!(
        "{}/user/starred/{}/{}",
        GITHUB_API_BASE,
        owner.trim(),
        repo.trim()
    )
}

/// 构建带认证头的 GitHub API 客户端（令牌仅放 header，永不落日志）。
fn authed_client(token: &str) -> Result<reqwest::Client, String> {
    let timeout_sec = crate::config::get_project_config().network.api_timeout_seconds;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_sec))
        .build()
        .map_err(|e| format!("创建网络请求失败: {}", e))?;
    let _ = token;
    Ok(client)
}

fn auth_headers(token: &str) -> Result<reqwest::header::HeaderMap, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("ZStore-Client/0.1.0"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github.v3+json"),
    );
    let v = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.trim()))
        .map_err(|_| "认证令牌格式无效".to_string())?;
    headers.insert(reqwest::header::AUTHORIZATION, v);
    Ok(headers)
}

/// 拉取当前令牌对应的 GitHub 用户（`login` + `avatar_url` + `has_list_scope`）。
pub async fn fetch_oauth_user(token: &str) -> Result<OAuthUser, String> {
    let client = authed_client(token)?;
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
    if resp.status().as_u16() == 401 {
        return Err("GitHub 授权已失效 (401)，请重新登录".to_string());
    }
    if !resp.status().is_success() {
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
    })
}

/// 查询是否已 Star（204 = 已 Star，404 = 未 Star）。
pub async fn check_starred(token: &str, owner: &str, repo: &str) -> Result<bool, String> {
    let client = authed_client(token)?;
    let resp = client
        .get(starred_api_url(owner, repo))
        .headers(auth_headers(token)?)
        .send()
        .await
        .map_err(|e| format!("查询 Star 状态失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    match resp.status().as_u16() {
        204 => Ok(true),
        404 => Ok(false),
        401 => Err("GitHub 授权已失效 (401)，请重新登录".to_string()),
        403 => Err("GitHub API 限额已耗尽 (403)，请稍后重试".to_string()),
        code => Err(format!("查询 Star 状态失败，HTTP 状态码: {}", code)),
    }
}

/// Star 指定仓库（幂等，PUT 成功返回 204）。
/// 并自动尝试将仓库归入 GitHub User List（z-store-list 列表）。
pub async fn star_repo(token: &str, owner: &str, repo: &str) -> Result<StarRepoOutcome, String> {
    let client = authed_client(token)?;
    let resp = client
        .put(starred_api_url(owner, repo))
        .headers(auth_headers(token)?)
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Star 失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
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
                    "已在 GitHub 成功标星！但该仓库属于组织「{}」，组织开启了第三方 OAuth 访问限制，GitHub 拒绝第三方应用将其写入清单。如需将组织仓库归入清单，请在「设置」中配置个人访问令牌 (PAT)。",
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
    } else if resp.status().as_u16() == 401 {
        Err("GitHub 授权已失效 (401)，请重新登录".to_string())
    } else if resp.status().as_u16() == 403 {
        Err("Star 失败 (403)：令牌缺少 public_repo 权限或 API 限额已耗尽".to_string())
    } else {
        Err(format!("Star 失败，HTTP 状态码: {}", resp.status()))
    }
}

/// 将已 Star 的仓库归入 GitHub User List（默认列表名：z-store-list）。
/// 若当前令牌缺少 `user` scope 或 GraphQL 返回权限错误，返回 InsufficientScopes，保证调用方获得准确反馈。
pub async fn add_repo_to_star_list(
    token: &str,
    owner: &str,
    repo: &str,
) -> Result<AddToListOutcome, String> {
    let client = authed_client(token)?;
    let headers = auth_headers(token)?;
    let gql_url = format!("{}/graphql", GITHUB_API_BASE);

    // 1. 查询当前用户的列表（含已有仓库 item 以保留既有归类）及目标仓库 node id
    let query = r#"
        query($owner: String!, $name: String!) {
          viewer {
            lists(first: 50) {
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
                }
              }
            }
          }
          repository(owner: $owner, name: $name) {
            id
          }
        }
    "#;

    let payload = serde_json::json!({
        "query": query,
        "variables": {
            "owner": owner.trim(),
            "name": repo.trim()
        }
    });

    let resp = client
        .post(&gql_url)
        .headers(headers.clone())
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("GraphQL 查询失败: {}", e))?;

    if !resp.status().is_success() {
        return Ok(AddToListOutcome::Failed(format!(
            "GraphQL HTTP 异常: {}",
            resp.status()
        )));
    }

    let val: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 GraphQL 响应失败: {}", e))?;

    if let Some(errs) = val.get("errors").and_then(|e| e.as_array()) {
        for err in errs {
            if err.get("type").and_then(|t| t.as_str()) == Some("INSUFFICIENT_SCOPES") {
                return Ok(AddToListOutcome::InsufficientScopes);
            }
        }
    }

    let repo_id = match val.pointer("/data/repository/id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Ok(AddToListOutcome::Failed("未找到对应仓库 ID".to_string())),
    };

    // 寻找现有的 z-store-list 或 star-list 列表，同时收集该仓库已归属的其他列表予以保留
    let mut target_list_id: Option<String> = None;
    let mut item_list_ids: Vec<String> = Vec::new();

    if let Some(nodes) = val.pointer("/data/viewer/lists/nodes").and_then(|v| v.as_array()) {
        for n in nodes {
            let id = n.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let name = n.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let lower = name.trim().to_lowercase();
            if lower == "z-store-list" || lower == "star-list" {
                target_list_id = Some(id.to_string());
            }
            if let Some(items) = n.pointer("/items/nodes").and_then(|v| v.as_array()) {
                for it in items {
                    if it.get("id").and_then(|v| v.as_str()) == Some(&repo_id) {
                        if !id.is_empty() && !item_list_ids.contains(&id.to_string()) {
                            item_list_ids.push(id.to_string());
                        }
                        break;
                    }
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
                  createUserList(input: { name: "z-store-list", description: "Z-Store 标星应用清单 (Star List)" }) {
                    list {
                      id
                      name
                    }
                  }
                }
            "#;
            let create_payload = serde_json::json!({ "query": create_mutation });
            let create_resp = client
                .post(&gql_url)
                .headers(headers.clone())
                .json(&create_payload)
                .send()
                .await
                .map_err(|e| format!("创建列表失败: {}", e))?;

            if !create_resp.status().is_success() {
                return Ok(AddToListOutcome::Failed(format!(
                    "创建列表 HTTP 状态码: {}",
                    create_resp.status()
                )));
            }

            let create_val: serde_json::Value = create_resp
                .json()
                .await
                .map_err(|e| format!("解析创建列表响应失败: {}", e))?;

            if let Some(errs) = create_val.get("errors").and_then(|e| e.as_array()) {
                for err in errs {
                    if err.get("type").and_then(|t| t.as_str()) == Some("INSUFFICIENT_SCOPES") {
                        return Ok(AddToListOutcome::InsufficientScopes);
                    }
                }
            }

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

    // 2. 将仓库更新到列表集合中
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
            let err_type = err
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or_default();
            let err_msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or_default();
            if err_type == "INSUFFICIENT_SCOPES" {
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
    let client = authed_client(token)?;
    let resp = client
        .delete(starred_api_url(owner, repo))
        .headers(auth_headers(token)?)
        .send()
        .await
        .map_err(|e| format!("取消 Star 失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    if resp.status().is_success() {
        Ok(())
    } else if resp.status().as_u16() == 401 {
        Err("GitHub 授权已失效 (401)，请重新登录".to_string())
    } else {
        Err(format!("取消 Star 失败，HTTP 状态码: {}", resp.status()))
    }
}
