use super::*;

#[test]
fn test_repository_url_parser() {
    // 1. 网页 URL：Codeberg
    let cb = RepositoryUrlParser::parse("https://codeberg.org/FreeTube/FreeTube").unwrap();
    assert_eq!(cb.forge, ForgeType::Codeberg);
    assert_eq!(cb.host, "codeberg.org");
    assert_eq!(cb.owner, "FreeTube");
    assert_eq!(cb.repo, "FreeTube");
    assert_eq!(cb.to_app_id(), "codeberg:FreeTube/FreeTube");

    // 2. 网页 URL：包含 .git 后缀的 GitHub 仓库
    let gh = RepositoryUrlParser::parse("https://github.com/localsend/localsend.git").unwrap();
    assert_eq!(gh.forge, ForgeType::GitHub);
    assert_eq!(gh.host, "github.com");
    assert_eq!(gh.owner, "localsend");
    assert_eq!(gh.repo, "localsend");
    assert_eq!(gh.to_app_id(), "localsend/localsend");

    // 3. 网页 URL：自建 Gitea / Forgejo 实例
    let custom = RepositoryUrlParser::parse("https://git.disroot.org/user/my-app/").unwrap();
    assert_eq!(custom.forge, ForgeType::Gitea);
    assert_eq!(custom.host, "git.disroot.org");
    assert_eq!(custom.owner, "user");
    assert_eq!(custom.repo, "my-app");
    assert_eq!(custom.to_app_id(), "gitea:git.disroot.org/user/my-app");

    // 4. 短语法：codeberg:owner/repo
    let cb_short = RepositoryUrlParser::parse("codeberg:author/repo").unwrap();
    assert_eq!(cb_short.forge, ForgeType::Codeberg);
    assert_eq!(cb_short.owner, "author");
    assert_eq!(cb_short.repo, "repo");

    // 5. 传统语法：owner/repo
    let classic = RepositoryUrlParser::parse("rustdesk/rustdesk").unwrap();
    assert_eq!(classic.forge, ForgeType::GitHub);
    assert_eq!(classic.owner, "rustdesk");
    assert_eq!(classic.repo, "rustdesk");
    assert_eq!(classic.to_app_id(), "rustdesk/rustdesk");

    // 6. 网页 URL：GitLab
    let gl = RepositoryUrlParser::parse("https://gitlab.com/inkscape/inkscape").unwrap();
    assert_eq!(gl.forge, ForgeType::GitLab);
    assert_eq!(gl.host, "gitlab.com");
    assert_eq!(gl.owner, "inkscape");
    assert_eq!(gl.repo, "inkscape");
    assert_eq!(gl.to_app_id(), "gitlab:inkscape/inkscape");

    // 7. 无效输入判定
    assert!(RepositoryUrlParser::parse("invalid query here").is_none());
    assert!(RepositoryUrlParser::parse("").is_none());
}

#[test]
fn test_forge_type_metadata() {
    assert_eq!(ForgeType::GitHub.default_host(), "github.com");
    assert_eq!(ForgeType::Codeberg.default_host(), "codeberg.org");
    assert_eq!(ForgeType::GitLab.default_host(), "gitlab.com");
}

#[test]
fn test_matches_host_exact_or_subdomain_not_substring() {
    // 精确命中 + 白名单子域；子串/前缀伪装域不命中（contains 判定已废）。
    assert!(ForgeType::GitHub.matches_host("github.com"));
    assert!(ForgeType::GitHub.matches_host("api.github.com"));
    assert!(!ForgeType::GitHub.matches_host("xx-github.com"));
    assert!(!ForgeType::GitHub.matches_host("github.com.evil.com"));
    assert!(!ForgeType::GitHub.matches_host("notgithub.com"));
    assert!(ForgeType::Codeberg.matches_host("codeberg.org"));
    assert!(!ForgeType::Codeberg.matches_host("xx-codeberg.org"));
}

#[test]
fn test_parse_rejects_injectable_segments() {
    // owner/repo 段含 `?`/`#`/空白：解析出口整体拒绝（原实现原样保留，可注入 URL 路径）。
    assert!(RepositoryUrlParser::parse("https://github.com/o w/r").is_none());
    assert!(RepositoryUrlParser::parse("https://github.com/o?x=1/r").is_none());
    assert!(RepositoryUrlParser::parse("https://github.com/o#x/r").is_none());
    assert!(RepositoryUrlParser::parse("github:o w/r").is_none());
    assert!(RepositoryUrlParser::parse("codeberg:o#x/r").is_none());
    // host 段拒绝查询注入；经典分支整串空格已在门禁拒绝，tab 经段校验拒绝。
    assert!(RepositoryUrlParser::parse("gitea:evil.com?a=b/owner/repo").is_none());
    assert!(RepositoryUrlParser::parse("o\tr/r2").is_none());
}

#[test]
fn test_parse_host_detection_exact_not_substring() {
    // 伪装域不再误入 GitHub/Codeberg/GitLab 分支，回落自建 Gitea。
    assert_eq!(
        RepositoryUrlParser::parse("https://xx-github.com/o/r")
            .unwrap()
            .forge,
        ForgeType::Gitea
    );
    assert_eq!(
        RepositoryUrlParser::parse("https://github.com.evil.com/o/r")
            .unwrap()
            .forge,
        ForgeType::Gitea
    );
    // 白名单子域仍命中。
    assert_eq!(
        RepositoryUrlParser::parse("https://api.github.com/o/r")
            .unwrap()
            .forge,
        ForgeType::GitHub
    );
}
