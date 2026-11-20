# Issue 03: 前端「README 徽章与深链分享器（`<ShareBadgeModal>`）」与多入口集成

Status: resolved
Blocked by: none

## Summary

构建通用的 `<ShareBadgeModal>` 单色徽章与协议深链分享弹窗，并在开源广场卡片（`<LaunchpadCard>`）和全站应用详情页顶栏（`AppDetailModal/Header`）挂载分享按钮，让作者和推荐者一键复制 `zstore://launchpad/{id}` / `zstore://app/{id}` 深链及符合 D4 单色风格的 GitHub README Markdown/HTML 徽章代码。

## Scope

- Allowed to modify:
  - `src/utils/shareBadge.ts`（新增纯函数：生成协议深链、Shields 单色徽章 URL、Markdown 片段、HTML 片段）
  - `src/utils/shareBadge.test.ts`（新增单测）
  - `src/components/ShareBadgeModal.tsx`（新增，基于 `<ModalShell>`）
  - `src/components/ShareBadgeModal.test.tsx`（新增单测）
  - `src/views/LaunchpadView/LaunchpadCard.tsx` & `src/views/LaunchpadView.tsx`（卡片操作栏增加分享按钮并打开 `<ShareBadgeModal>`）
  - `src/components/AppDetailModal/Header.tsx` & `src/components/AppDetailModal/index.tsx`（详情页顶栏增加分享按钮）
  - `src/styles/components-modal.css`（单色徽章预览盒与代码复制块样式）
  - `src/locales/zh-CN.json` & `src/locales/en-US.json`（补充 `share_badge.*` 词条）
- Do not modify:
  - `src-tauri/` 后端文件（无需新增后端接口，纯前端生成）

## Implementation Details

1. **纯函数生成器（`src/utils/shareBadge.ts`）**：
   - 输入：`{ id: string; name: string; target: 'launchpad' | 'app'; style: 'dark' | 'light' }`；
   - `deepLinkUrl`：
     - `target === 'launchpad'` → `zstore://launchpad/${id}`
     - `target === 'app'` → `zstore://app/${id}`
   - `shieldsBadgeUrl`：
     - 严格单色配色：`dark` 使用 `#111111`（白字），`light` 使用 `#f4f4f5`（搭配 `labelColor=111111` 或单色灰白边框风格），对 `id` 做 Shields 特殊字符转义（`-` → `--`、`_` → `__`、空格 → `_` + `encodeURIComponent`）；
   - `markdownSnippet`：`[![Get on ZStore](${shieldsBadgeUrl})](https://z-store-web.pages.dev)` 附带引导说明，另提供可直连协议的深链片段 `zstore://...` 供桌面/社区场景直接粘贴；
   - `htmlSnippet`：对应的标准 `<a href="..."><img src="..." alt="Get ${name} on ZStore" /></a>`。
2. **`<ShareBadgeModal>` 组件（`src/components/ShareBadgeModal.tsx`）**：
   - 基于 `<ModalShell layer={layer}>`（从列表卡片触发传 `layer="base"`，从 `AppDetailModal` 内触发传 `layer="confirm"`，遵循四级叠放层级）；
   - **界面布局**：
     - 徽章预览卡片（展示真实 `<img src={shieldsBadgeUrl} />` 或本地单色降级 SVG 预览）；
     - 单色样式切换（`<SegmentedControl>`：`深色 #111111` / `浅色 #f4f4f5`）；
     - 3 个一键复制块（均使用 `copyTextToClipboard` + `useTransientFeedback`）：
       1. 协议深链（`zstore://launchpad/...` 或 `zstore://app/...`）；
       2. Markdown 徽章代码；
       3. HTML 嵌入代码。
3. **入口挂载**：
   - `LaunchpadCard.tsx`：新增可选回调 `onShareBadge?: (entry: LaunchpadEntry) => void`，在操作区渲染紧凑 `Share2` 图标按钮（`strokeWidth={1.5}`，`btn-icon-only`）；`LaunchpadView.tsx` 挂载 `<ShareBadgeModal>`。
   - `AppDetailModal/Header.tsx`：在顶栏操作按钮簇（与收藏/关注/刷新同级）增加 `Share2` 图标按钮，点击打开 `<ShareBadgeModal layer="confirm" />`。

## Acceptance Criteria

- [x] `shareBadge.test.ts` 验证：`launchpad` 与 `app` 两种深链路由格式、Shields URL 特殊字符（`-` / `_`）正确转义、深浅单色参数、HTML 属性转义防 XSS。
- [x] `ShareBadgeModal.test.tsx` 验证：样式切换实时更新代码预览、点击复制协议深链/Markdown/HTML 写入剪贴板并显示已复制反馈。
- [x] 从 `AppDetailModal` 打开时层级高于 `base`（遵循 `modalLayers.test.ts` 约束），`Esc` 仅关闭 `<ShareBadgeModal>` 而不关闭底层的 `AppDetailModal`。
