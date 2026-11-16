# z-store-launchpad

ZStore「开源广场（Launchpad）」的数据仓：一份静态清单 `launchpad.json` 加上几条 GitHub Actions，组成零后端的投稿、上架、置顶与热度刷新流程。客户端从 `raw.githubusercontent.com` 拉取清单（失败时可经加速镜像重试一次），不依赖任何自建服务，也不做任何行为埋点。

清单与 `z-store-catalog` 的 `catalog.json` 相互独立：广场里的作品不会自动进入精选目录，客户端也不会把它们写进目录表。

## 准入门槛

免费上架和置顶推荐（Spotlight）的门槛相同：

- 公开仓库，托管在 GitHub、Codeberg、Gitea 或 GitLab，非归档、非 Fork；
- 协议在 ZStore 37 项 OSI 白名单内（与客户端 `[license_gate]` 同源）；
- 最新 Release 至少带一个可安装的构建资产。

置顶坑位最多 4 个，到期后自动撤回「最新上架」流，卡片上始终带单色的「置顶推荐 / Spotlight」标记。

## 目录

| 路径 | 作用 |
| --- | --- |
| `launchpad.json` | 客户端消费的清单（单一事实源） |
| `state/stars-history.json` | 星数快照，只在星数变化时写入，用于计算 `stars_7d_delta` |
| `schema/launchpad.schema.json` | JSON Schema（Draft 2020-12） |
| `scripts/validate-launchpad.mjs` | 结构与跨字段不变量校验 |
| `scripts/verify-submission.mjs` | 解析投稿 Issue，体检仓库、协议与 Release 资产 |
| `scripts/publish-launch.mjs` | 打标上架：坑位保护、Discussion、写清单、回复物料包 |
| `scripts/refresh-pulse-and-pins.mjs` | 每日撤下到期置顶，刷新星数与讨论热度 |
| `scripts/bootstrap-repo.sh` | 初始化标签，打印需手动开启的仓库设置 |

## 流程

1. **投稿**：作者用「开源广场投稿」Issue 模板提交，自动带 `launchpad-submission` 标签。
2. **体检**（`validate-submission.yml`）：解析表单、请求托管源公开 API，在 Issue 中维护一条体检报告与卡片预览，结果为 `validated` 或 `needs-changes`。
3. **上架**（`publish-launch.yml`）：仓库写权限成员打上 `approved`、`pinned-7d`、`pinned-14d`、`pinned-30d` 或 `featured-7d` 后，脚本复检仓库、检查置顶坑位、复用或在 `Launches` 分类创建 Discussion，写入清单并推送，然后回复深链与 README 徽章并关闭 Issue。坑位已满时不写入，并在 Issue 中给出最早释放时间。
4. **保鲜**（`expire-pins-and-pulse.yml`，每日 UTC 00:15）：撤下到期置顶，批量刷新星数、Fork、版本、评论数与顶帖数，只在数据变化时提交。

所有写 `launchpad.json` 的工作流共享并发组 `launchpad-json-write`，按顺序执行。

## 初始化

```bash
GH_REPO=superMC5657/z-store-launchpad scripts/bootstrap-repo.sh
```

脚本创建所需标签并列出网页上的剩余步骤：开启 Discussions、新建 `Launches` 分类、为 Actions 开启读写权限。

## 本地开发

需要 Node.js 20 或更高版本，无第三方依赖。

```bash
npm run validate
npm test
```

## 安全

- Issue 正文只经环境变量传给脚本，工作流的 `run:` 中不直接插值任何 Issue 内容；
- GraphQL 一律通过 `variables` 传参；
- 赞助凭证字段只接受订单号或交易尾号，体检报告不会回显它。
