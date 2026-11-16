# Issue 07: 外部 `z-store-launchpad` 自动预审、打标一键上架与每日置顶过期降级 GitHub Actions 工作流

Status: done
Blocked by: 06

## Summary

在外部数据仓 `superMC5657/z-store-launchpad` 实现全自动零后端运营闭环：
1. **作者提单自动体检与预览（`validate-submission.yml`）**；
2. **维护者打标自动建 Discussion、写 `launchpad.json`、回复 `zstore://` 专属深链并关单（`publish-launch.yml`）**；
3. **每日定时扫描 `pin_until` 撤下到期置顶并刷新 7 日 Star 增量与讨论热度（`expire-pins-and-pulse.yml`）**；
4. **PR/Push Schema 守护工作流（`validate-schema.yml`）与仓库标签/Discussions 初始化脚本（`scripts/bootstrap-repo.sh`）**。

## Scope

- Target repository: `superMC5657/z-store-launchpad`:
  - `scripts/verify-submission.mjs` & `scripts/verify-submission.test.mjs`
  - `scripts/publish-launch.mjs` & `scripts/publish-launch.test.mjs`
  - `scripts/refresh-pulse-and-pins.mjs` & `scripts/refresh-pulse-and-pins.test.mjs`
  - `scripts/bootstrap-repo.sh`
  - `.github/workflows/validate-submission.yml`
  - `.github/workflows/publish-launch.yml`
  - `.github/workflows/expire-pins-and-pulse.yml`
  - `.github/workflows/validate-schema.yml`

## Implementation Details

### 1. 投稿自动预检工作流（`validate-submission.yml` + `verify-submission.mjs`）

- 触发器：`on: { issues: { types: [opened, edited, reopened] } }`，最小权限 `permissions: { issues: write, contents: read }`。
- 安全防注入：**严禁**在 `run:` shell 中直接插值 `${{ github.event.issue.body }}` 或标题！一律通过环境变量 `ISSUE_BODY: ${{ github.event.issue.body }}` 传给 Node 脚本解析。
- 校验项：
  1. 解析 `submit-launchpad.yml` 渲染出的 `### <Heading>` 段落，提取 `repo_url`、`app_name`、`category`、`maker_note` 等；
  2. 请求对应托管源公开 API（GitHub `/repos/{o}/{r}` + `/repos/{o}/{r}/releases/latest`；Codeberg/Gitea `/api/v1/repos/{o}/{r}`；GitLab `/api/v4/projects/{encoded}`）：验证非私有、非归档、SPDX 协议命中 37 项 OSI 名单、存在至少 1 个有效安装包构建资产（复用客户端同口径后缀规则推导 `platforms`）；
  3. 校验 `maker_note` 单行折叠后长度 `1..=140` 字符；
- 输出：在当前 Issue 创建或更新（通过隐藏标记 `<!-- zstore-launchpad-bot-preview -->` 幂等编辑，避免编辑 Issue 刷屏）结构化体检表 + 预览 JSON；全绿打 `validated` 标签并移除 `needs-changes`，否则打 `needs-changes` 并移除 `validated`。

### 2. 维护者打标自动上架工作流（`publish-launch.yml` + `publish-launch.mjs`）

- 触发器：`on: { issues: { types: [labeled] } }`，过滤标签属于 `['approved', 'pinned-7d', 'pinned-14d', 'pinned-30d', 'featured-7d']`；
- 权限与串行锁：
  - `permissions: { contents: write, issues: write, discussions: write }`；
  - `concurrency: { group: launchpad-json-write, cancel-in-progress: false }`（严格串行排队，杜绝两个 Issue 同时打标造成 `git push` 冲突）；
  - 操作人门禁：校验 `github.event.sender` 具有仓库 `ADMIN` / `MAINTAIN` / `WRITE` 权限后才执行。
- 执行步骤：
  1. `git pull --rebase` 获取最新 `launchpad.json`，二次运行 `verify-submission` 确保上架瞬间仓库仍合规；
  2. **置顶坑位保护**：若本次标签为 `pinned-<N>d` 或 `featured-7d`：
     - 先剔除 `pinned` 中已过期的旧项；若剩余有效置顶（不含当前同 `id` 续期项）已达 `4` 个，**中止置顶写入**，在 Issue 自动回复当前最早释放时间（`min(pin_until)`）并移除本次 `pinned-*` 标签，提醒维护者排队或改打 `approved` 先入普通池；
     - 坑位可用时计算 `pin_until = now + N days`（ISO UTC），`pin_tier = label.startsWith('featured') ? 'featured' : 'sponsor'`；
  3. **自动创建或复用 GitHub Discussion**：
     - 若作者填写了合法的同仓库/公开 GitHub `linked_discussion_url`，查询确认其 `number` 与 `node_id`；
     - 否则若 `launchpad.json` 存量同 `id` 行已有 `discussion_number`，直接复用；
     - 否则调用 GraphQL `repository(owner, name) { id discussionCategories(first: 20) { nodes { id name slug } } }` 定位 `Launches` 分类，执行 `createDiscussion` 创建专属讨论帖，回填 `discussion_repo`、`discussion_number`、`discussion_node_id`、`discussion_url`；
  4. 更新 `launchpad.json` → 运行 `validate-launchpad.mjs` 自检 → `git commit & push`；
  5. 在 Issue 回复作者专属传播卡片，包含：
     - 广场直达深链：`zstore://launchpad/{id}`
     - 应用详情深链：`zstore://app/{id}`
     - 社区讨论帖链接：`{discussion_url}`
     - 可直接贴入项目 README 的单色徽章 Markdown 片段；
  6. 调用 GitHub API 将 Issue 关闭（`state: 'closed', state_reason: 'completed'`）并打上 `published` 标签。

### 3. 每日置顶到期撤下与社交脉冲刷新（`expire-pins-and-pulse.yml` + `refresh-pulse-and-pins.mjs`）

- 触发器：`schedule: [{ cron: '15 0 * * *' }]` + `workflow_dispatch`，共享 `concurrency: { group: launchpad-json-write, cancel-in-progress: false }`，权限 `permissions: { contents: write }`。
- 执行逻辑：
  1. 扫描 `pinned`：移除所有 `Date.parse(pin_until) <= now` 的过期项，重排剩余项 `pin_order = 1..k`（被移除项仍保留在 `items` 中，自动回归普通新品流）；
  2. 对 `items` 批量刷新最新公开统计（GitHub 项目可用单次批量 GraphQL 别名查询每批 25 个仓库的 `stargazerCount`、`forkCount`、`latestRelease` 与对应 Discussion 的 `upvoteCount`、`comments.totalCount`，极省配额！非 GitHub 源走对应公开 REST API）；
  3. 更新 `state/stars-history.json`（保留近 14 天每日星数快照），计算每个项目相对 7 天前（不足 7 天取最早快照即上架初始星数）的增量 `stars_7d_delta = max(0, current_stars - baseline_stars)`；
  4. 若 `pinned` 或 `items` 发生实质变更，通过 `validate-launchpad.mjs` 校验后提交推送；无变更则零 Commit 退出。

### 4. 维护者一键初始化辅助脚本（`scripts/bootstrap-repo.sh`）

- 提供基于 `gh` CLI 的幂等命令脚本，一键在 `superMC5657/z-store-launchpad` 创建所需全部标签（`launchpad-submission`、`validated`、`needs-changes`、`approved`、`pinned-7d`、`pinned-14d`、`pinned-30d`、`featured-7d`、`published`），并输出在仓库 Settings 开启 `Discussions` 及新建 `Launches` 分类的核对清单（人类仅需在 GitHub 网页勾选一次 `Discussions` 开关并建 `Launches` 分类）。

## Acceptance Criteria

- [ ] Node 单测（`node --test scripts/*.test.mjs`）完整覆盖：
  - Issue Form Markdown 解析（含多行自荐语、空选填项、恶意 Markdown 边界）；
  - 置顶满 4 个坑位时的拒绝与最早到期提示逻辑、同 `id` 续期幂等更新逻辑；
  - `pin_until` 到期撤下后 `items` 完整保留且不丢讨论编号；
  - `stars-history.json` 跨天滚动裁剪与 `stars_7d_delta` 计算准确性。
- [ ] 全部 `.github/workflows/*.yml` 无表达式注入漏洞（零 `${{ github.event.issue.* }}` 直接拼入 `run:` 脚本行），且写操作工作流均声明同一 `launchpad-json-write` 并发组。
