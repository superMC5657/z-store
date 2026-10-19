# ADR-0018：开源协议门禁可配（`license_gate`）与 D1 默认严格

- 状态：Accepted
- 日期：2026-10-17
- 关联：ADR-0017（本地自维护草稿 overlay）、D1 纯粹开源
- 范围：仅后端（`config.toml [license_gate]` + `LicenseGateConfig` 解析 +
  提交档门禁判定）；前端开关 UI 不做（SettingsView
  保持现状），门禁静默生效、无用户提醒。

## 1. 背景

D1 要求仅收录 OSI 认证开源协议，提交档校验（`SubmitStrict`）历史上写死
OSI 全量名单。用户需求希望门禁可开关、可控范围（例如本地实验性收录
非 OSI 条目），但默认必须保持 D1 严格，且关闭行为只影响本地、可审计。

## 2. 决策

1. **`config.toml [license_gate]`**：`enabled=true`（默认开）、`allowed=[...]`
   （默认与 OSI 全量名单同序同值）；名单唯一源头为
   `config::DEFAULT_LICENSE_ALLOWLIST`，校验侧直接引用，不各自手写。
2. **解析**：`config::LicenseGateConfig{enabled, allowed}`，名单匹配两侧均经
   `normalize_license` 归一（config 子集大小写/空格形态同样命中）。
   门禁唯一源为编译时 config：行为只由 `config.toml` 在编译发行时确定，
   无运行时覆盖、无用户提醒，静默生效。
3. **生效点**：仅提交档（`mark_submitted` / 单条与批量预填 PR 链接）；
   暂存档（`DraftLenient`）行为不变。门禁关闭放行任意非空 license，但记
   WARN 审计日志（`license gate DISABLED … (local-only bypass, non-official)`，
   口径参照 `fetch_remote_catalog` 非默认源 WARN，仅日志文件可见）。
   前端 `validatePendingDraft` 是 UI 即时镜像（同步内联报错，名单取自本命令只读查询），
   `validate_custom_item` 是唯一权威；两侧由同一份契约样例
   `tests/fixtures/draft-validation-cases.json` 各跑一遍
   （`PendingView.validationParity.test.ts` / `db::custom_apps::tests::draft_validation_matches_shared_parity_cases`），
   新增规则先加样例再实现。协议归一两侧逐字符把空格/下划线折成 `-`（不折叠连续空白），
   连续空格样例已纳入契约集。
4. **关闭只影响本地**：官方生态仓（`z-store-catalog`）仍以 OSI 为准；
   本地放行的条目提交到官方仓后仍走官方 PR 准入校验，不保证合入。

## 3. 为何默认严格且关闭可审计

- 默认开 + 全量名单 = D1 行为零变化（既有单测不改断言即全绿）；
  用户显式关闭才放宽，且每次放行留 WARN 痕迹，可审计、可回溯。
- 名单可配子集只做收窄语义的显式表达（`allowed=[MIT]` 即仅 MIT 可提交），
  空名单/非法覆盖一律回退基线，杜绝“误配即全拒/全放”。

## 4. 后果

- 正面：本地实验/企业内源场景可关可配；官方口径不受影响。
- 中性：`validate_custom_item` / 批量预填 URL 构建函数新增 `gate` 参数
  （单条构建无门禁注记）。
- 风险：用户关闭门禁后提交的非 OSI 条目在官方仓被拒——WARN 日志已明示
  “仅本地生效”，风险外显而非静默（日志可见，不打扰用户）。
