use super::*;

#[test]
fn test_repository_url_parser() {
    // 1. Web URL: Codeberg
    let cb = RepositoryUrlParser::parse("https://codeberg.org/FreeTube/FreeTube").unwrap();
    assert_eq!(cb.forge, ForgeType::Codeberg);
    assert_eq!(cb.host, "codeberg.org");
    assert_eq!(cb.owner, "FreeTube");
    assert_eq!(cb.repo, "FreeTube");
    assert_eq!(cb.to_app_id(), "codeberg:FreeTube/FreeTube");

    // 2. Web URL: GitHub with .git
    let gh = RepositoryUrlParser::parse("https://github.com/localsend/localsend.git").unwrap();
    assert_eq!(gh.forge, ForgeType::GitHub);
    assert_eq!(gh.host, "github.com");
    assert_eq!(gh.owner, "localsend");
    assert_eq!(gh.repo, "localsend");
    assert_eq!(gh.to_app_id(), "localsend/localsend");

    // 3. Web URL: 自建 Gitea / Forgejo 实例
    let custom = RepositoryUrlParser::parse("https://git.disroot.org/user/my-app/").unwrap();
    assert_eq!(custom.forge, ForgeType::Gitea);
    assert_eq!(custom.host, "git.disroot.org");
    assert_eq!(custom.owner, "user");
    assert_eq!(custom.repo, "my-app");
    assert_eq!(custom.to_app_id(), "gitea:git.disroot.org/user/my-app");

    // 4. 短语法: codeberg:owner/repo
    let cb_short = RepositoryUrlParser::parse("codeberg:author/repo").unwrap();
    assert_eq!(cb_short.forge, ForgeType::Codeberg);
    assert_eq!(cb_short.owner, "author");
    assert_eq!(cb_short.repo, "repo");

    // 5. 传统 owner/repo
    let legacy = RepositoryUrlParser::parse("rustdesk/rustdesk").unwrap();
    assert_eq!(legacy.forge, ForgeType::GitHub);
    assert_eq!(legacy.owner, "rustdesk");
    assert_eq!(legacy.repo, "rustdesk");
    assert_eq!(legacy.to_app_id(), "rustdesk/rustdesk");

    // 6. Web URL: GitLab
    let gl = RepositoryUrlParser::parse("https://gitlab.com/inkscape/inkscape").unwrap();
    assert_eq!(gl.forge, ForgeType::GitLab);
    assert_eq!(gl.host, "gitlab.com");
    assert_eq!(gl.owner, "inkscape");
    assert_eq!(gl.repo, "inkscape");
    assert_eq!(gl.to_app_id(), "gitlab:inkscape/inkscape");

    // 7. 无效字符
    assert!(RepositoryUrlParser::parse("invalid query here").is_none());
    assert!(RepositoryUrlParser::parse("").is_none());
}

#[test]
fn test_forge_type_metadata() {
    assert_eq!(ForgeType::GitHub.icon(), "🐙");
    assert_eq!(ForgeType::Codeberg.icon(), "🏔️");
    assert_eq!(ForgeType::Gitea.icon(), "🍵");
    assert_eq!(ForgeType::GitLab.icon(), "🦊");
    assert_eq!(ForgeType::GitHub.default_host(), "github.com");
    assert_eq!(ForgeType::Codeberg.default_host(), "codeberg.org");
    assert_eq!(ForgeType::GitLab.default_host(), "gitlab.com");
}
