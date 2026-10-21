# Issue 20: components 层约 200 处中文硬编码绕过 i18n

Status: resolved
Priority: P2（i18n）
来源: 2026-10-21 全项目审查 · 前端核心分片

## 描述

`src/components/AppDetailModal/Header.tsx:281-594`、`AssetList.tsx:31-82`、
`IconLevelBadge.tsx:5-9` 等详情弹窗组件约 200 处用户可见中文硬编码（aria-label/title/
正文）；`src/App.tsx:843,850` 安装确认弹窗 intro 与兜底"未知来源"同样硬编码。全 src
非 defaultValue 硬编码约 240 处。en-US 环境下仍显示中文。`views.i18n.test.tsx` 只扫
views，components 子目录无覆盖。

## 修复方向

- 三处重点文件逐条迁入 `src/i18n.ts` + locales 两侧补 key（当前 zh/en 各 580 键对齐，
  迁移后保持对齐）。
- 扩展 i18n 测试扫描范围至 components/（可参照 views.i18n.test.tsx 的机制），防回流。
- aria-label/ title 属性一并迁移（可访问性文案同属用户可见）。

## Comments

- 迁移口径按 TS AST 精确清点（字符串字面量/模板片段/JSX 文本，注释天然不在位）：
  Header.tsx 47 处 + AssetList.tsx 13 处 + IconLevelBadge.tsx 5 处 + App.tsx 安装确认
  两弹窗 4 处（deeplink intro/未知来源 + unverified intro/source），共 69 处；审查估算
  的"约 200 处"含中文注释与 aria 外围。Header 另有 3 处 `t('app.supported_devices',
  { defaultValue })` 既有用法按工单"非 defaultValue"口径豁免保留。
- locales 新增 60 键：新 `detail` 段 54 键（图标档位名/弹窗动作 aria+title/徽章/资产
  列表）、新 `install_confirm` 段 4 键、`toast` 段补 2 键（图标切换成功/失败）；zh/en
  两侧同步 602 → 662 键且集合相等，对齐由新扫描门禁静态断言（见下）。
- `ICON_LEVEL_NAMES`（中文表）改 `ICON_LEVEL_NAME_KEYS`（i18n 键映射，联合类型收窄），
  翻译在唯一消费方 Header 的 `t()` 处取值；`|| \`L${n}\`` / `|| ''` 两条回退语义原样
  保留（下一档 title 用 L{n} 兜底，toast 名用空串兜底）。
- 弹窗收藏 title 复用既有 `app.fav_active`（与硬编码值逐字相同，不造重复键）；平台
  title 的"支持设备:"前缀同型复用 `app.supported_devices`（与相邻 L511 一致）。
  GitHub issue 预填标题/正文模板迁 `detail.issue_feedback_title/_body`
  （`{{version}}`/`{{platform}}` 插值，encodeURIComponent 行为不变）。
- 测试扩面两条腿：
  1. 静态门禁 `src/components/components.i18n.scan.test.ts`：AST 扫描 MIGRATED_FILES
     （现 3 个已迁文件）断言零 CJK 用户可见字面量（defaultValue 豁免），后续迁移文件
     追加清单即纳入防回流；同文件断言 zh/en 键集合相等。
  2. 行为级 `src/components/AppDetailModal/AppDetailModal.i18n.test.tsx` 5 用例
     （views.i18n.test.tsx 同机制）：Header 动作按钮 aria/title/徽章、图标切换 toast
     （监听 zstore:toast 事件断言双语文本）、刷新成功反馈徽章、AssetList 全文案、
     install_confirm 四键双语取值。
- 连带修复：4 个存量测试渲染迁移组件但从未初始化 i18n（此前硬编码文案不依赖 t()，
  迁移后 t() 未初始化会直返键名）——`Header.l5cycle` / `AppDetailModal.starVerify` /
  `AppDetailModal.readme` 补 `import i18n`（badgeConsistency 渲染面仅 AppCard/
  InstallActions，未涉及本批文件，不动）。
- 范围外留待后续：App.tsx 其余 10 处（L192 草稿失败 toast、搜索区 L663-684）不在本
  工单点名的弹窗两处内；components 其余 ~26 文件仍含 CJK（Toast/ErrorBoundary/
  useDetailStarVerify 等），扫描门禁以 MIGRATED_FILES 清单渐进扩面，不做一次性超大
  迁移。
- 回归：components 全量 17 文件 108 用例 + views.i18n + i18n.test 全绿；pnpm build
  （tsc + vite）绿。
