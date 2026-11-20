# Issue 02: 前端开源广场「应用内投稿预检向导（`<LaunchpadSubmitModal>`）」与实时卡片预览

Status: resolved
Blocked by: 01

## Summary

在前端接入 `preflight_launchpad_submission` IPC 与 Demo Mock，构建基于 `<ModalShell>` 的 `<LaunchpadSubmitModal>` 投稿预检向导，让开发者在 ZStore 内完成仓库坐标校验、自荐语编辑、协议/产物门禁自检与 `<LaunchpadCard>` 实时效果预览，并一键生成带全部预填参数的 GitHub Issue Form URL。

## Scope

- Allowed to modify:
  - `src/types/index.ts`（新增 `PreflightCheckItem`、`LaunchpadPreflightResult`、`LaunchpadTier` 类型）
  - `src/services/api.ts`（`CMD` 注册 `preflightLaunchpadSubmission: 'preflight_launchpad_submission'`）
  - `src/services/api/launchpad.ts`（新增 `preflightLaunchpadSubmission`）
  - `src/demo/handlers/launchpad.ts` & `src/demo/tauri-mock.ts`（补齐 `preflight_launchpad_submission` Demo Mock）
  - `src/utils/launchpadSubmit.ts`（新增纯函数：`maker_note` 清洗校验、预填 `LaunchpadEntry` 组装、`submit-launchpad.yml` Issue URL 构造器）
  - `src/utils/launchpadSubmit.test.ts`（新增单测）
  - `src/views/LaunchpadView/LaunchpadSubmitModal.tsx`（新增，基于 `<ModalShell>`）
  - `src/views/LaunchpadView/LaunchpadSubmitModal.test.tsx`（新增测试）
  - `src/views/LaunchpadView.tsx`（在投稿 `<FlyoutMenu>` 新增「应用内预检投稿（推荐）」入口并挂载 `<LaunchpadSubmitModal>`）
  - `src/styles/components-launchpad.css`（新增预检向导双栏与单色检查列表样式）
  - `src/locales/zh-CN.json` & `src/locales/en-US.json`（补充 `launchpad.wizard.*` 词条）
- Do not modify:
  - `src-tauri/` 后端文件
  - `src/views/PendingView.tsx`（保持精选目录投稿流程独立）

## Implementation Details

1. **纯函数与表单校验（`src/utils/launchpadSubmit.ts`）**：
   - 分类选项枚举与 `z-store-launchpad` 的 10 类完全一致：`dev | system | network | media | security | graphics | office | reading | ops | games`；
   - `launch_tier` 选项对齐 `submit-launchpad.yml`：`free`、`spotlight-7d`、`spotlight-14d`、`spotlight-30d`；
   - `maker_note` 校验：去除换行符，长度 `1..=140` 字符；`maker_note_en` 可选、同样限制 `<= 140` 字符；
   - `buildLaunchpadIssueUrl(baseIssueUrl, form)`：按 GitHub Issue Form URL query 规范编码写入 `template=submit-launchpad.yml`（保留基础 URL 查询参数）、`title=[Launchpad] ${appName}`、`repo_url`、`app_name`、`category`、`maker_note`、`maker_note_en`、`launch_tier`、`custom_icon_url`。
2. **`<LaunchpadSubmitModal>` 组件（`src/views/LaunchpadView/LaunchpadSubmitModal.tsx`）**：
   - 基于 `<ModalShell>`（`layer="base"`），包含左右分栏（窄屏上下堆叠）：
     - **左侧表单**：仓库地址 input（已登录时提供快捷填入当前账号前缀按钮）、应用名称（预检返回后自动填充空框）、分类 select、中文自荐语 textarea（实时显示 `<CountBadge>` / 140 字限提示）、可选英文自荐语、上架档位 select、可选自定义 `https://` 图标；
     - **右侧自检与预览**：
       - 「运行上架预检」按钮（`SearchCheck` / `RefreshCw` 图标），调用 `tauriApi.preflightLaunchpadSubmission(repoUrl, customIconUrl)`；
       - 预检检查列表（协议/Release/图标/查重），单色图标状态标识（pass/warn/fail）；
       - **所见即所得卡片预览**：基于预检返回与当前表单值组装 `LaunchpadEntry`，渲染禁用了真实交互副作用的 `<LaunchpadCard variant={launchTier === 'free' ? 'recent' : 'spotlight'} />`（点击预览卡片按钮仅弹出轻提示或屏蔽外发请求）；
   - **底部按钮**：取消 + 「前往 GitHub 提交投稿」（仅在最近一次预检 `ok === true` 且表单必填通过校验时启用，点击后调用 `tauriApi.openUrl(issueUrl)`）。
3. **与 `LaunchpadView.tsx` 集成**：
   - 保留原 `submitIssueUrl`（直接打开 GitHub 表单）与 `submitWebUrl`（官网投稿指南），将「应用内预检投稿（推荐）」作为 Flyout 第一项，空态卡片按钮也可直接打开该向导。

## Acceptance Criteria

- [x] `launchpadSubmit.test.ts` 验证：`maker_note` 超 140 字或含换行报错、Issue URL 精准包含编码后的 `repo_url`/`app_name`/`category`/`maker_note`/`launch_tier` 参数。
- [x] `LaunchpadSubmitModal.test.tsx` 验证：运行预检后展示检查项与实时 `<LaunchpadCard>` 预览；预检 `ok === false` 时提交按钮禁用；预检通过且填写自荐语后点击提交调用 `openUrl`。
- [x] `cmdAlignment.test.ts` 与 `ipcArgsNaming.test.ts`、`views.i18n.test.tsx`、`countDisplay.test.ts` 通过。
