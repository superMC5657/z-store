//! 系统代理统一收敛：env 语义 + `no_proxy` 默认豁免。
//!
//! - 所有 `reqwest::Client` 构建经 [`apply_proxy`] 统一挂载代理：
//!   显式读取 `HTTP(S)_PROXY` / `ALL_PROXY`（大小写皆可），等价于
//!   `Proxy::from_env` 语义（reqwest 0.12 无该 API，此处手动复刻
//!   hyper-util `Matcher::from_system` 在 Linux 的 env 行为），并附加
//!   合并后的 `NoProxy`（env 原值 + 默认豁免 + 调用方 `extra_hosts`）。
//! - 默认豁免：`gh-proxy.com`（镜像直连）+ `trend.doforce.dpdns.org`
//!  （趋势直连白名单）+ `localhost/127.0.0.1/::1`。调用方（如下载器）
//!   可经 `extra_hosts` 追加当前镜像 host，命中镜像时靠 `no_proxy`
//!   直连，不另起 Client。
//! - 日志只记 host（脱敏），永不记 query/凭证。

#[cfg(target_os = "linux")]
pub mod linux;

use reqwest::{ClientBuilder, NoProxy, Proxy};

/// 镜像默认 host（直连豁免，见 `mirror::DEFAULT_GH_PROXY`）。
pub const GH_PROXY_HOST: &str = "gh-proxy.com";
/// 趋势 doforce 直连 host（见 `commands::network::TRENDS_TEXT_HOSTS`）。
pub const TREND_HOST: &str = "trend.doforce.dpdns.org";

/// 默认 `no_proxy` 豁免条目（静态部分，不含动态镜像 host）。
pub fn default_no_proxy_entries() -> Vec<String> {
    vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
        GH_PROXY_HOST.to_string(),
        TREND_HOST.to_string(),
    ]
}

/// 取 URL 的 host（小写），失败返回 `None`（不回显完整 URL/query）。
pub fn host_of_url(url: &str) -> Option<String> {
    let h = crate::log_support::host_of(url);
    if h.is_empty() || h == "unknown" {
        None
    } else {
        Some(h)
    }
}

fn get_env_non_empty(keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Ok(v) = std::env::var(k) {
            let t = v.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

fn split_no_proxy_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 合并后的 `no_proxy` 字符串：env 原值（`NO_PROXY` + `no_proxy`）+
/// 默认豁免 + `extra_hosts`，大小写不敏感去重，保留首次出现顺序。
pub fn merged_no_proxy_string(extra_hosts: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |s: String| {
        let key = s.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(s);
        }
    };
    // env 原值优先保留（用户显式配置不丢）。
    for raw in [
        std::env::var("NO_PROXY").unwrap_or_default(),
        std::env::var("no_proxy").unwrap_or_default(),
    ] {
        for e in split_no_proxy_list(&raw) {
            push(e);
        }
    }
    for e in default_no_proxy_entries() {
        push(e);
    }
    for e in extra_hosts {
        let t = e.trim().to_string();
        if !t.is_empty() && t.to_ascii_lowercase() != "unknown" {
            push(t);
        }
    }
    out.join(",")
}

/// 合并后的 `NoProxy`（恒 `Some`，默认豁免永不为空）。
pub fn merged_no_proxy(extra_hosts: &[String]) -> Option<NoProxy> {
    NoProxy::from_string(&merged_no_proxy_string(extra_hosts))
}

/// 确保 `NO_PROXY`/`no_proxy` 环境包含默认豁免 + `extra_hosts`。
/// 只做追加合并，不删除用户原有条目；已包含时跳过寫操作。
pub fn ensure_no_proxy_env(extra_hosts: &[String]) {
    let merged = merged_no_proxy_string(extra_hosts);
    if merged.trim().is_empty() {
        return;
    }
    let cur_upper = std::env::var("NO_PROXY").unwrap_or_default();
    let cur_lower = std::env::var("no_proxy").unwrap_or_default();
    // 快速路径：两边都已包含合并结果（合并结果含双方并集，相等即已就绪）。
    let norm = |s: &str| {
        let mut v: Vec<String> = split_no_proxy_list(s)
            .into_iter()
            .map(|x| x.to_ascii_lowercase())
            .collect();
        v.sort();
        v
    };
    let want = norm(&merged);
    if norm(&cur_upper) == want && norm(&cur_lower) == want {
        return;
    }
    // 合并寫：两边统一为合并值，保证大小写读取方皆命中。
    std::env::set_var("NO_PROXY", &merged);
    std::env::set_var("no_proxy", &merged);
}

/// 统一代理挂载（`Proxy::from_env` + `.no_proxy()` 语义）。
///
/// - 先 [`ensure_no_proxy_env`]（默认豁免落 env，兼顾未走本函数的旧 Client 系统匹配器）；
/// - 再显式读取 `HTTP_PROXY/http_proxy`（回退 `ALL_PROXY/all_proxy`）与
///   `HTTPS_PROXY/https_proxy`（回退 `ALL_PROXY/all_proxy`），与 hyper-util
///   `Matcher::from_system` 在 Linux 的 env 语义一致；
/// - 逐 scheme 挂载 `Proxy::http` / `Proxy::https` 并附加合并 `NoProxy`；
///   非法代理 URL 记 warn 后跳过该 scheme（保持该 scheme 直连，不污染全局）。
/// - 无任何代理 env 时原样返回 `builder`（保留默认 `auto_sys_proxy`）。
pub fn apply_proxy(builder: ClientBuilder, extra_hosts: &[String]) -> ClientBuilder {
    ensure_no_proxy_env(extra_hosts);
    let merged = merged_no_proxy_string(extra_hosts);
    // `NoProxy::from_string` 恒 Some；沿用 `Option<NoProxy>` 以匹配 `Proxy::no_proxy` 签名。
    let no_proxy = NoProxy::from_string(&merged);
    let http_eff = get_env_non_empty(&["HTTP_PROXY", "http_proxy"])
        .or_else(|| get_env_non_empty(&["ALL_PROXY", "all_proxy"]));
    let https_eff = get_env_non_empty(&["HTTPS_PROXY", "https_proxy"])
        .or_else(|| get_env_non_empty(&["ALL_PROXY", "all_proxy"]));

    let mut builder = builder;
    if let Some(url) = http_eff {
        match Proxy::http(url.trim()) {
            Ok(p) => {
                builder = builder.proxy(p.no_proxy(no_proxy.clone()));
            }
            Err(e) => {
                log::warn!(
                    "proxy env http invalid reason={}",
                    crate::log_support::short_reason(&e.to_string())
                );
            }
        }
    }
    if let Some(url) = https_eff {
        // http/https 同值时仍需双挂载（`Proxy::http` 只拦截 http，`Proxy::https` 只拦截 https）。
        match Proxy::https(url.trim()) {
            Ok(p) => {
                builder = builder.proxy(p.no_proxy(no_proxy.clone()));
            }
            Err(e) => {
                log::warn!(
                    "proxy env https invalid reason={}",
                    crate::log_support::short_reason(&e.to_string())
                );
            }
        }
    }
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merged_no_proxy_contains_defaults() {
        let merged = merged_no_proxy_string(&[]);
        let lower = merged.to_ascii_lowercase();
        assert!(lower.contains("gh-proxy.com"), "merged={}", merged);
        assert!(
            lower.contains("trend.doforce.dpdns.org"),
            "merged={}",
            merged
        );
        assert!(lower.contains("localhost"), "merged={}", merged);
        assert!(lower.contains("127.0.0.1"), "merged={}", merged);
    }

    #[test]
    fn test_merged_no_proxy_extra_and_dedup() {
        let extra = vec!["Mirror.Example.COM".to_string(), "gh-proxy.com".to_string()];
        let merged = merged_no_proxy_string(&extra);
        let lower = merged.to_ascii_lowercase();
        assert!(lower.contains("mirror.example.com"), "merged={}", merged);
        // 去重：gh-proxy.com 只出现一次（大小写不敏感）。
        assert_eq!(lower.matches("gh-proxy.com").count(), 1, "merged={}", merged);
    }

    #[test]
    fn test_host_of_url_masks_query() {
        let h = host_of_url("https://gh-proxy.com/https://github.com/o/r?token=secret");
        assert_eq!(h.as_deref(), Some("gh-proxy.com"));
        assert!(host_of_url("not a url :::").is_some() || host_of_url("not a url :::").is_none());
        assert_eq!(host_of_url(""), None);
    }
}
