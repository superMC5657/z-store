<div align="center">

<a href="https://z-store-web.pages.dev"><img src="src-tauri/icons/128x128@2x.png" width="112" alt="ZStore"></a>

# ZStore

### Helping users find great open-source apps, and makers find their first users.

**Curated GitHub open-source apps, community-maintained lists, and a Launchpad for Vibe Coding makers.**<br>
Discover trending tools, try fresh indie releases, and star or discuss them without leaving the app —<br>
then let ZStore install, verify, and keep them updated for you.

[![Release](https://img.shields.io/github/v/release/superMC5657/z-store?label=release&color=111111)](https://github.com/superMC5657/z-store/releases/latest) [![Stars](https://img.shields.io/github/stars/superMC5657/z-store?style=flat&color=111111)](https://github.com/superMC5657/z-store/stargazers) [![License](https://img.shields.io/badge/license-GPL--3.0--only-111111)](LICENSE)<br>
![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white) ![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black) ![macOS](https://img.shields.io/badge/macOS_(source)-000000?logo=apple&logoColor=white)

**[Download](https://z-store-web.pages.dev/en/download)** &nbsp;·&nbsp; **[Live Demo](https://z-store-demo.pages.dev)** &nbsp;·&nbsp; **[Docs](https://z-store-web.pages.dev/en/docs)** &nbsp;·&nbsp; **[Catalog](https://github.com/superMC5657/z-store-catalog)** &nbsp;·&nbsp; **[Launchpad](https://github.com/superMC5657/z-store-launchpad)** &nbsp;·&nbsp; **English** · [简体中文](README.zh-CN.md)

</div>

<br>

## Is ZStore for you?

Great open-source software is scattered across millions of GitHub repositories and hard to find. And if you build a useful tool yourself — maybe in a single afternoon of Vibe Coding — publishing a release on GitHub usually means nobody ever sees it.

ZStore connects both sides in one desktop store, with no backend server:

- **For users looking for software**: Browse 360+ popular open-source apps out of the box, follow GitHub's daily, weekly, and monthly trends, or point ZStore at any community-maintained `catalog.json` list.
- **For makers looking for users**: Shipped a new open-source tool? List it on **Launchpad** with a single GitHub Issue. People can discover it, read your one-line pitch, upvote with `+1`, comment, star, and install it — all inside the app.
- **And the chores in between**: Once you find an app you like, ZStore picks the right package for your OS, verifies its SHA-256 checksum, tracks updates, and can even adopt open-source apps already installed on your machine.

If you already know exactly what you want and are happy running `winget` or `brew` in a terminal, you don't need ZStore. It's built for **discovering** great open-source software — and for **getting discovered** when you ship some.

## Quick start

**Looking for apps?**

1. Try the **[Live Demo](https://z-store-demo.pages.dev)** in your browser, or download the **Windows** (`.exe`) or **Linux** (`.AppImage` / `.deb`) build from **[z-store-web.pages.dev](https://z-store-web.pages.dev/en/download)** or **[GitHub Releases](https://github.com/superMC5657/z-store/releases)**. On macOS, [build from source](#build-from-source) for now.
2. Browse **Featured**, **Latest**, **Trends**, **Launchpad**, or **Categories**. The built-in catalog opens instantly, even offline, and syncs new entries from [z-store-catalog](https://github.com/superMC5657/z-store-catalog).
3. Press `⌘K` / `Ctrl+K` to search your catalog and all of GitHub at once, or switch to a community catalog URL under **Settings → Catalog**.

**Shipping an open-source app?**

- Submit a new project to **[Launchpad](https://github.com/superMC5657/z-store-launchpad)** using its Issue template. Once merged, it shows up in the Launchpad feed with a direct `zstore://launchpad/owner/repo` link and a README badge.
- Submit an established project to **[z-store-catalog](https://github.com/superMC5657/z-store-catalog)** — or draft it under **Pending** in the app and send it upstream from there.

## Features

### 1 · Find great open-source software

| | |
| :-- | :-- |
| **Curated & community lists** | Ships with 360+ popular GitHub apps and syncs incrementally from [z-store-catalog](https://github.com/superMC5657/z-store-catalog). Swap the sync URL for any community-maintained `catalog.json`, or add a missing app locally under **Pending** and submit a pre-filled Issue upstream in one click. |
| **Trends & Latest** | Follow GitHub's daily, weekly, monthly, and rising trending boards, or open **Latest** to see what was just added. |
| **Local recommendations** | **Featured** builds personalized shelves from your stars, installs, and browsing history — computed entirely on your machine. |
| **Cross-platform filters** | Filter any view by platform (`Windows`, `macOS`, `Linux`, `Android`, `iOS`) and across 10 categories at the same time. |
| **Beyond GitHub** | Search all of GitHub live, or pull releases from **Codeberg**, **GitLab**, **Forgejo**, and **self-hosted Gitea**. |

### 2 · Launchpad: a front door for Vibe Coding makers

Built something useful with Vibe Coding and cut a release, but not sure how to reach your first users?

**Launchpad** is a dedicated space inside ZStore for new indie open-source tools. It's kept separate from the curated catalog, so fresh projects get seen right away instead of waiting months to qualify.

- **Launch with one Issue**: Open an Issue on [z-store-launchpad](https://github.com/superMC5657/z-store-launchpad) (public repo, OSI-approved license, installable release). Automated checks validate the repo and publish your card along with your one-line **Maker Note**.
- **Engagement inside the app**: Users can read your note, upvote with `+1`, discuss via GitHub Discussions, **Star** the repo, and **Install** it — without leaving ZStore.
- **Shareable deep links**: Every launch gets a `zstore://launchpad/owner/repo` link for your README or release notes.
- **Transparent Spotlight & sponsorships**: Up to 4 Spotlight slots at the top sustain the project through curated open-source highlights and clearly labeled developer-oriented commercial sponsorships. Sponsored entries are strictly isolated from the curated catalog and recommendation scoring, with no ad networks and no behavioral tracking.

### 3 · Installs and updates, handled

Once you find an app you want to try, ZStore takes care of the tedious parts:

- **The right asset, verified**: Picks the matching `.msi`, `.exe`, portable `.zip` / tarball, `.AppImage`, `.deb`, `.rpm`, `.dmg`, or `.pkg` for your OS and CPU, and checks its SHA-256 against `checksums.txt` / `SHA256SUMS` before anything runs. `.apk`, `.7z`, and other archives are downloaded with SHA-256 verification too.
- **Faster downloads**: An optional download mirror prefix (`https://gh-proxy.com` by default, with a one-click speed test), plus live system proxy / TUN support (Clash, v2ray, etc.) that applies without a restart.
- **Updates on your terms**: Check all installed apps for updates at once, skip a broken version, pin an app to its current build, or watch a repo for new releases before you install it.
- **Adopt existing apps**: Optionally scan for open-source apps already on your computer (Windows Registry / Scoop / Start Menu, Linux `.desktop` / AppImage, macOS `/Applications`) and manage their updates in one place.

<details>
<summary><b>Deep links</b> — open an app, a search, or a launch from your browser or terminal</summary>

<br>

```sh
zstore://launchpad/owner/repo      # open a Launchpad entry
zstore://app/localsend/localsend   # open an app's detail page
zstore://install/videolan/vlc      # open the install confirmation (never installs silently)
zstore://search?q=markdown         # search inside ZStore
zstore://developer/rustdesk        # list all open-source apps by an author
zstore://view/updates              # jump to available updates
```

</details>

## Privacy

ZStore has no backend server and collects no analytics or telemetry — not even Launchpad views or clicks.

Your browsing history, search history, favorites, update rules, and recommendation preferences are stored in a local SQLite database on your computer. You can turn off local activity signals or GitHub profile signals at any time under **Settings → User Profile**.

Signing in with GitHub is optional and uses Device Flow. It raises API rate limits and lets you import your stars and comment or upvote on Launchpad. Your token never leaves your machine and is excluded from backup exports.

## Build from source

Requires [Node.js](https://nodejs.org/) (>= 18), [pnpm](https://pnpm.io/) (>= 9), [Rust](https://rustup.rs/) (>= 1.77), and your platform's C++ / WebKitGTK build tools.

```sh
pnpm install
pnpm tauri dev      # run the desktop app in dev mode
pnpm tauri build    # build a release installer
```

Run tests and checks:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
pnpm check
```

Architecture notes and design decisions (ADRs) live in [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), and [docs/adr/](docs/adr/).

## License

Licensed under the [GNU General Public License v3.0 only (`GPL-3.0-only`)](LICENSE).

- **Commercial licensing**: Proprietary, OEM, or private enterprise distributions without `GPL-3.0-only` copyleft obligations are available under a separate commercial license (see [`NOTICE`](NOTICE) and [`CONTRIBUTING.md`](CONTRIBUTING.md)).
- **Trademarks**: The `ZStore` name and official icons are not licensed under the GPL; forks must use distinct branding.
