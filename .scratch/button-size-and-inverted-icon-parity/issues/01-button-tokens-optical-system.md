# 01: 全局按钮三档尺寸体系、语义变体补全与反色光学补偿基础设施

Status: resolved
Blocked by: 无

## 目标与背景

建立全站唯一的按钮尺寸契约与反色光学补偿基座（`src/styles/components-buttons.css`、`src/styles/tokens.css`、`src/styles/components-modal.css`、`src/components/icons/PlatformIcons.tsx`、`src/components/InlineConfirmButton.tsx`），消除各视图因缺少 `28px` 标准档、缺失 `.btn-danger`/`.btn-warning` 与缺少反色光学收敛而各自内联魔改样式的问题。

## 验收清单

- [x] **确立 `.btn-fluent` 三档严格盒模型尺寸（`src/styles/components-buttons.css`）**：
  - 默认（`md`）：`height: 30px; min-height: 30px; max-height: 30px; padding: 0 12px; font-size: var(--font-base); gap: 6px; border: 1px solid transparent; box-sizing: border-box;`；内部 `svg` 默认 `14px × 14px`。
  - 新增 `.btn-fluent.btn-compact`（`28px` 档）：`height: 28px; min-height: 28px; max-height: 28px; padding: 0 10px; font-size: var(--font-sm); gap: 5px;`；内部 `svg` 默认 `13px × 13px`。
  - 收紧 `.btn-fluent.btn-sm`（`26px` 档）：`height: 26px; min-height: 26px; max-height: 26px; padding: 0 8px; font-size: var(--font-sm); gap: 4px;`；内部 `svg` 默认 `12px × 12px`。
  - 统一 `.btn-fluent.btn-icon-only` 通用正方形纯图标支持：`padding: 0; width: 30px;`（`md`）、`.btn-compact.btn-icon-only { width: 28px; }`、`.btn-sm.btn-icon-only { width: 26px; }`。
  - 确保 `a.btn-fluent` 同步继承 `text-decoration: none; line-height: 1; box-sizing: border-box;` 且 hover/active/disabled 绝不改变盒高与边框厚度。
- [x] **补全缺失的 `.btn-danger` 与 `.btn-warning` 语义变体（`src/styles/components-buttons.css`）**：
  - 定义 `.btn-danger`（subtle 危险边框与字色 `var(--status-danger)`，hover 进 `var(--status-danger-bg)`）与 `.btn-danger-solid`（实底红底白字二次确认态，供 `InlineConfirmButton` 确认态或危险强确认动作使用）。
  - 定义 `.btn-warning`（`var(--status-warning)` 边框与 subtle hover）。
  - 修复 `src/components/InlineConfirmButton.tsx`：移除取消按钮第 64 行硬写 `width: 30px; height: 30px` 内联样式，改用 `.btn-fluent.btn-secondary.btn-icon-only`（自动随尺寸类如 `btn-compact`/`btn-sm` 与同行主按钮保持 100% 等高）。
- [x] **同排外投影归一化与反色按钮光学收敛（`src/styles/components-buttons.css`、`tokens.css`）**：
  - 将原先脆弱的 `div:has(> .btn-fluent.btn-secondary) > .btn-fluent.btn-primary` 升级为对任意同排并列容器（含 `btn-secondary`、`btn-ghost`、`.btn-danger`、`.manage-btn-action`、`.btn-install`、或含 `.btn-fluent` 兄弟的容器）生效的去外投影规则，或统一让 `.btn-fluent.btn-primary` 仅使用内敛 `var(--btn-primary-inset)`（不再外扩 `0 1px 2px` 阴影），消除并列剪影高度差。
  - **反色主按钮光学体积收敛**：
    - 在保持物理 `height` 完全一致的前提下，针对高反差实底按钮（`[data-theme="dark"] .btn-primary` 的亮白实底、`[data-theme="light"] .btn-primary` 的纯黑实底、`.btn-danger-solid`），使用 `background-clip: padding-box` 与 `0.5px` 内边界光学补偿（或在深色模式用微收高对比中性白 `#ECEEEF` 替代刺眼纯白，hover 再提至 `#F7F8F8`），抵消辐射错觉（Irradiation Illusion）造成的视觉偏大。
    - 对反色实底按钮（`.btn-primary`、`.btn-danger-solid`）内的图标实施光学微缩：`.btn-fluent.btn-primary svg, .btn-fluent.btn-danger-solid svg { transform: scale(0.92); }`（或对应降低 1px 视框），使白底黑图标/黑底白图标与旁边透明描边按钮里的图标在视觉上完全等大。
- [x] **实心品牌图标与激活态反色图标光学平衡（`PlatformIcons.tsx` & 共享样式）**：
  - 在 `src/components/icons/PlatformIcons.tsx` 中，针对 `fill="currentColor"` 的实心剪影图标（`WindowsIcon`、`AppleIcon`、`GitHubIcon`、`GitLabIcon`、`CodebergIcon`），在其 `24×24` viewBox 内按中心施加 `scale(0.86)`（或封装 `.icon-solid-optical` 类名统一缩放），使其视觉面积与同级的线性描边图标（`LinuxIcon`、`AndroidIcon`、`IosIcon`、`OtherIcon`、`GiteaIcon`）完全匹配。
  - 提供统一的交互激活态（如 `Watch` 眼睛）半透明填充+实心瞳孔规范类，杜绝实心填充糊掉内部细节与视觉胀大。

## Comments

- 2026-11-12：由全站按钮尺寸与反色图标审计 Spec (`spec.md`) 拆出，作为后续各视图与弹窗重构的样式基座。
- 2026-11-12：已实施 `components-buttons.css`、`tokens.css`、`InlineConfirmButton.tsx` 与 `PlatformIcons.tsx` 改造，`pnpm check` 与 `pnpm build` 通过。
- 2026-11-13：根据用户要求移除反色实底图标 scale(0.92) 微缩规则，保持图标原始 1:1 视框渲染。
