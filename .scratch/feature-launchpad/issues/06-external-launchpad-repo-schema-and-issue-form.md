# Issue 06: 外部 `z-store-launchpad` 数据仓脚手架、`launchpad.json` Schema 与结构化投稿 Issue Form

Status: ready-for-agent
Blocked by: none

## Summary

为独立外部数据仓库 `superMC5657/z-store-launchpad` 构建完整的静态清单 Schema、零依赖 Node 校验脚本与结构化作者投稿 Issue Form 套件（若本地工作区尚未克隆 `z-store-launchpad`，可先产出至独立目录或 `docs/launchpad-repo-kit/` 供直接初始化推送至 `superMC5657/z-store-launchpad`）。

## Scope

- Target repository: `superMC5657/z-store-launchpad`（独立生态数据仓，不混入客户端打包体积）：
  - `launchpad.json`
  - `state/stars-history.json`
  - `schema/launchpad.schema.json`
  - `scripts/validate-launchpad.mjs`
  - `scripts/validate-launchpad.test.mjs`
  - `.github/ISSUE_TEMPLATE/config.yml`
  - `.github/ISSUE_TEMPLATE/submit-launchpad.yml`
  - `README.md`
  - `CONTRIBUTING.md`

## Implementation Details

### 1. `schema/launchpad.schema.json` 与业务不变量校验（`scripts/validate-launchpad.mjs`）

- 严格约束 `launchpad.json`（`version: 1`）：
  - `pinned` 数组长度 `0..=4`；每项含必填 `id`、`pin_until`（ISO-8601 UTC 字符串）、`pin_tier`（`"sponsor" | "featured"`）、`pin_order`（`1..=4` 整数）；
  - `items` 数组每项必填：`id`（小写规范坐标：GitHub 为 `owner/repo`，其他源为 `forge:owner/repo` 或 `forge:host/owner/repo`）、`name`、`owner`、`repo`、`forge`（`"github" | "codeberg" | "gitea" | "gitlab"`）、`forge_host`、`icon`（`""` 或 `^https://`，禁止 `http://` 与 `data:`）、`icon_bg`、`description`、`maker_note`（`1..=140` 字符，无换行控制符）、`maker`（`{ login, name?, avatar_url, html_url }`）、`category`（ZStore 标准 10 类枚举：`dev | system | network | media | security | graphics | office | reading | ops | games`）、`category_name`、`license`（命中 ZStore 37 项 OSI SPDX 名单）、`latest_version`、`platforms`（子集于 `["windows", "macos", "linux", "android", "ios"]`，去重非空）、`stars`、`stars_7d_delta`、`forks`、`launched_at`、`discussion_repo`、`discussion_number`（正整数）、`discussion_url`、`discussion_comments_count`、`discussion_upvotes`；可选字段：`description_en`、`maker_note_en`、`latest_release_at`、`homepage`、`discussion_node_id`。
- `validate-launchpad.mjs` 额外检查跨字段不变量：
  1. `items` 内 `id` 全局唯一且与 `(forge, forge_host, owner, repo)` 推导结果完全一致；
  2. `pinned` 内 `id` 不重复，且每个 `pinned[i].id` 均存在于 `items` 中；
  3. 所有时间字段（`generated_at`, `pin_until`, `launched_at`, `latest_release_at`）均可解析为合法 UTC 时间戳。

### 2. 结构化作者投稿表单（`.github/ISSUE_TEMPLATE/submit-launchpad.yml`）

- 自动附加标签 `["launchpad-submission"]`，标题前缀 `[Launchpad] `；
- 表单字段 ID（与 Issue 07 自动解析器严格对齐）：
  - `repo_url`（input, required）：开源仓库地址（如 `https://github.com/owner/repo` 或 `https://codeberg.org/owner/repo`）；
  - `app_name`（input, required）：应用展示名称；
  - `category`（dropdown, required）：ZStore 10 大标准分类选项；
  - `maker_note`（textarea, required）：作者一句话自荐语（中文，建议 20~120 字，上限 140 字）；
  - `maker_note_en`（textarea, optional）：英文一句话自荐语；
  - `launch_tier`（dropdown, required）：
    - `free — 免费加入「最新上架」新品池`
    - `spotlight-7d — 申请顶部「置顶推荐」7 天赞助位`
    - `spotlight-14d — 申请顶部「置顶推荐」14 天赞助位`
    - `spotlight-30d — 申请顶部「置顶推荐」30 天赞助位`
  - `sponsor_order_ref`（input, optional）：第三方赞助/收款凭证单号或交易尾号（附醒目隐私声明：公开 Issue 可见，仅填订单号或后 6 位供维护者核对，切勿填写任何密钥或个人敏感隐私）；
  - `custom_icon_url`（input, optional）：自定义高清图标 `https://` 直链；
  - `linked_discussion_url`（input, optional）：若希望绑定自有 GitHub 仓库已开启的特定 Discussion 链接（留空则由平台在 `z-store-launchpad` 自动创建专属讨论帖）；
  - `floss_confirm`（checkboxes, required）：确认项目为 OSI 认证开源软件、含可直接下载安装的 Release 构建资产，且不含恶意代码或闭源商业捆绑。

## Acceptance Criteria

- [ ] `node --test scripts/validate-launchpad.test.mjs` 覆盖并通过以下用例：
  - 合法的含置顶与多托管源条目的 `launchpad.json` 校验通过；
  - `pinned` 超过 4 条、引用不存在的 `id`、含重复 `id`、含 `data:image/png...` 图标、非 OSI 协议（如 `BUSL-1.1` / `NOASSERTION`）或超 140 字 `maker_note` 均精准报错并以非 0 退出码拦截。
- [ ] `submit-launchpad.yml` 符合 GitHub Issue Forms YAML 语法规范，全部字段 `id` 唯一且与解析脚本契约一致。
