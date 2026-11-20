<div align="center">

<a href="https://z-store-web.pages.dev"><img src="src-tauri/icons/128x128@2x.png" width="112" alt="ZStore"></a>

# ZStore

### 帮用户找到好用的开源软件，帮开发者找到第一批用户。

**精选 GitHub 热门开源软件，支持社区共建清单，还为 Vibe Coding 独立开发者留了一块新品门户。**<br>
逛热门、淘新作，在应用里顺手 Star 和讨论——<br>
找到之后，选包、校验、安装和更新也一并交给它。

[![Release](https://img.shields.io/github/v/release/superMC5657/z-store?label=release&color=111111)](https://github.com/superMC5657/z-store/releases/latest) [![Stars](https://img.shields.io/github/stars/superMC5657/z-store?style=flat&color=111111)](https://github.com/superMC5657/z-store/stargazers) [![License](https://img.shields.io/badge/license-GPL--3.0--only-111111)](LICENSE)<br>
![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white) ![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black) ![macOS](https://img.shields.io/badge/macOS_(源码编译)-000000?logo=apple&logoColor=white)

**[下载](https://z-store-web.pages.dev/zh/download)** &nbsp;·&nbsp; **[在线体验](https://z-store-demo.pages.dev)** &nbsp;·&nbsp; **[文档](https://z-store-web.pages.dev/zh/docs)** &nbsp;·&nbsp; **[精选收录库](https://github.com/superMC5657/z-store-catalog)** &nbsp;·&nbsp; **[开源广场](https://github.com/superMC5657/z-store-launchpad)** &nbsp;·&nbsp; [English](README.md) · **简体中文**

</div>

<br>

## ZStore 适合你吗？

GitHub 上好用的开源软件很多，却散落在数以百万计的仓库里，很难找。反过来，如果你自己用 Vibe Coding 做了个趁手的小工具，发到 GitHub Releases 后往往石沉大海，没人知道它的存在。

ZStore 把这两头连在了一起，而且不依赖任何中心服务器：

- **帮用户找软件**：内置 360+ 款 GitHub 热门开源软件，可以看每日 / 每周 / 每月趋势榜、最新入库和本地推荐，也能随时换成你自己或社区维护的清单（`catalog.json`）。
- **帮开发者找用户（开源广场）**：做出了新作品却缺第一批用户？提一个 GitHub Issue 就能免费上架**开源广场（Launchpad）**，附上一句话自荐语。用户在商店里就能看到它、`+1` 顶帖、讨论、点 Star，并一键试装。
- **顺带管好安装和更新**：找到想用的软件后，ZStore 会帮你挑对安装包、校验 SHA-256、接管电脑里早已装好的开源软件，并统一检查更新。

如果你早就清楚要装什么，习惯在终端敲一句 `winget` 或 `brew` 装完就走，那你并不需要它。ZStore 解决的是两个问题：**去哪发现好用的开源软件**，以及**做出来的开源新作怎么被人看见**。

## 快速开始

**想找软件？**

1. 先在浏览器里打开 **[在线体验](https://z-store-demo.pages.dev)** 逛一逛，或从 **[z-store-web.pages.dev](https://z-store-web.pages.dev/zh/download)** / **[GitHub Releases](https://github.com/superMC5657/z-store/releases)** 下载 **Windows**（`.exe`）或 **Linux**（`.AppImage` / `.deb`）安装包。macOS 用户目前请[从源码构建](#从源码构建)。
2. 打开即可浏览**精选**、**最新**、**趋势**、**开源广场**和**分类**。内置清单断网也能秒开，联网后会从 [z-store-catalog](https://github.com/superMC5657/z-store-catalog) 同步新收录。
3. 按 `⌘K` / `Ctrl+K` 可同时搜索本地库和整个 GitHub；想用别人或团队维护的清单，在 **设置 → 收录清单** 填入自定义 `catalog.json` 地址即可。

**做了开源作品想找用户？**

- 到 **[z-store-launchpad](https://github.com/superMC5657/z-store-launchpad)** 按模板提交投稿 Issue。审核合入后，作品就会出现在开源广场，同时附上一条 `zstore://launchpad/owner/repo` 直达链接和 README 徽章。
- 已经成熟的项目，可以在应用内的**待收录**里整理成草稿，一键生成 Issue，投稿到 **[z-store-catalog](https://github.com/superMC5657/z-store-catalog)**。

## 功能

### 1 · 帮用户找软件：精选收录与社区清单

| | |
| :-- | :-- |
| **精选收录 + 社区清单** | 内置 360+ 款 GitHub 热门开源软件，并从独立仓库 [z-store-catalog](https://github.com/superMC5657/z-store-catalog) 增量同步。清单源可随时换成任何社区维护的 `catalog.json`；遇到尚未收录的好软件，也能先在**待收录**里记入本地库，直接搜索和安装，再一键生成 Issue 投稿到官方清单。 |
| **趋势榜与最新入库** | 内置 GitHub 日榜、周榜、月榜和新秀榜，另有按收录时间倒序的**最新**视图，不错过刚火起来的项目。 |
| **本地口味推荐** | **精选**页根据你本地的收藏、安装和浏览习惯排序推荐，全部在本机计算，不上传云端。 |
| **跨平台双维筛选** | 任意页面都能按平台（Windows / macOS / Linux / Android / iOS）和 10 大分类交叉筛选。 |
| **不止 GitHub** | 除了在线搜索整个 GitHub，也原生支持 **Codeberg**、**GitLab**、**Forgejo** 和**自建 Gitea**。 |

### 2 · 帮开发者找用户：Vibe Coding 的新品门户（开源广场）

用 AI / Vibe Coding 花一个周末做出了好用的开源小工具，却不知道去哪找第一批真实用户？

**开源广场（Launchpad）** 是专为独立开源新作准备的曝光入口。它和精选收录库完全分开，不用苦等沉淀期，刚发布就能被逛商店的人看到。

- **应用内预检 + 一个 Issue 免费上架**：在商店内直接使用**投稿预检向导**（或前往 [z-store-launchpad](https://github.com/superMC5657/z-store-launchpad) 按模板提交），提交前当场核验公开仓库可达性、37 项 OSI 开源协议门禁、Release 可安装资产与图标探测效果，并在弹窗内实时预览广场卡片，通过后一键打开预填好的 GitHub Issue 表单确认提交。
- **应用内直接互动**：用户在 ZStore 里就能看介绍、点 `+1` 顶帖、通过 GitHub Discussions 提建议、点 **Star**，还能直接点**安装**试用。
- **自带深链与单色 README 徽章**：广场卡片与详情页顶栏均提供一键分享弹窗，可复制 `zstore://launchpad/owner/repo` / `zstore://app/owner/repo` 深层链接，以及 `#111111` / `#f4f4f5` 单色 Shields Markdown/HTML 徽章代码直接贴回项目 README 引流。
- **克制透明的置顶赞助**：顶部最多 4 个**置顶推荐（Spotlight）**，用于支持项目长期维护——既展示优质开源新品，也接受经人工审核的开发者向商业赞助与广告（明确标注状态标签）。赞助位与精选收录库、搜索和推荐算法完全隔离，不接第三方广告联盟，客户端零埋点、零追踪。

### 3 · 安装和更新，顺手搞定

挑到心仪的软件后，剩下的杂活交给 ZStore：

- **自动选包与 SHA-256 校验**：按系统和架构自动挑选 `.msi`、`.exe`、便携 `.zip` / 压缩包、`.AppImage`、`.deb`、`.rpm`、`.dmg` 或 `.pkg`，下载时流式核对 `checksums.txt` / `SHA256SUMS`，哈希不符立即拦截并删除。`.apk`、`.7z` 等格式同样支持应用内下载和校验。
- **国内网络也顺畅**：支持下载加速镜像（默认 `https://gh-proxy.com`，设置页可一键测速），并实时跟随 Clash / v2ray 等系统代理或 TUN 模式，切换代理无需重启。
- **更新你说了算**：在**我的应用**里一键检查所有已装软件的新版本，可以跳过某个版本、锁定当前版本、隐藏提醒，也可以先在**星标**页关注仓库动态。
- **接管已装软件**：可扫描本机早已装好的开源软件（Windows 注册表 / Scoop / 开始菜单、Linux `.desktop` / AppImage、macOS `/Applications`），确认后一键纳入更新管理，无需重装。

<details>
<summary><b>深层链接（zstore://）</b>—— 从浏览器或命令行直达新品、详情或搜索</summary>

<br>

```sh
zstore://launchpad/owner/repo      # 打开开源广场中的某个新品
zstore://app/localsend/localsend   # 打开应用详情
zstore://install/videolan/vlc      # 唤起安装确认弹窗（绝不静默安装）
zstore://search?q=markdown         # 在 ZStore 中搜索
zstore://developer/rustdesk        # 查看作者名下的全部开源项目
zstore://collection?title=Rust&ids=rustdesk/rustdesk,localsend/localsend  # 预览并批量安装分享合集
zstore://view/updates              # 直达可用更新列表
```

</details>

## 隐私

ZStore 没有后端服务器，不做任何埋点或遥测——开源广场的展示、点击和安装同样不会被追踪上报。

你的浏览记录、搜索历史、收藏、更新规则和推荐偏好都保存在本机的 SQLite 数据库里。你可以随时在 **设置 → 用户画像** 中关闭本地行为或 GitHub 信号的推荐。

GitHub 登录是可选的，通过 Device Flow 完成，用于提升 API 配额、导入自己的 Star 列表，以及在开源广场顶帖和评论。令牌只保存在本机，导出备份时也会被排除。

## 从源码构建

需要 [Node.js](https://nodejs.org/)（>= 18）、[pnpm](https://pnpm.io/)（>= 9）、[Rust](https://rustup.rs/)（>= 1.77），以及对应平台的 C++ / WebKitGTK 构建依赖。

```sh
pnpm install
pnpm tauri dev      # 以开发模式启动桌面端
pnpm tauri build    # 构建安装包
```

运行测试与检查：

```sh
cargo test --manifest-path src-tauri/Cargo.toml
pnpm check
```

架构说明与设计决策记录（ADR）见 [CONTEXT.md](CONTEXT.md)、[AGENTS.md](AGENTS.md) 和 [docs/adr/](docs/adr/)。

## 许可协议

本项目源码基于 [GNU General Public License v3.0 only（`GPL-3.0-only`）](LICENSE) 开源。

- **商业授权**：如需将 ZStore 用于闭源商业产品、OEM 预装或企业内网私有分发（豁免 GPLv3 开源传染义务），请联系作者获取商业双授权（详见 [`NOTICE`](NOTICE) 与 [`CONTRIBUTING.md`](CONTRIBUTING.md)）。
- **商标声明**：`GPL-3.0-only` 仅授予代码著作权许可，不包含 `ZStore` 名称与官方图标的商标授权；基于源码修改分发的衍生版本须更换独立名称与图标。
