# 待收录应用（Pending）最终版 Spec（本次会话）

> 来源：本会话全部已落地改动。口径：代码即真相，下面的文件行号为改动锚点。

## 1. catalog.json 模板口径（vscodium 例为准）

标准字段顺序（`identifiers` 恒尾）：

```
id, name, owner, repo, icon, icon_bg, description, description_en,
category, category_name, aliases, default_version, license,
stars, forks, is_verified, homepage,
[install_dirs?], [search_subdirs?], [publishers?],
platforms, identifiers
```

- Issue 载荷序列化风格：2 空格；字符串数组单行内联；`identifiers` 对象按固定键序展开；
  空数组/空对象/空串字段直接省略（不出现 `[]` 换行）。
- 前端：`src/services/api/catalog.ts`（`toOrderedPrPayload/formatPrObject/inlineJsonStringArray`）；
  后端：`src-tauri/src/commands/catalog_custom.rs`（`pr_single_payload_json/pr_batch_payload_json`）。

## 2. 草稿表单（draft 态）

- 字段 = 模板子集：无 `stars/forks/is_verified`（系统维护）；
  无 `发行商/安装目录/检索子目录` 输入（`collectFormItem` 恒 `[]`，载荷省略）。
- `icon` 只收远程 `http(s)`；`base64/data:`/相对路径置空走详情图标链回填；
  移入时先取 `restoreOrFetchIconCycle().remote_url` 真值。
- 启发式预填（可编辑，提交前人工校对，有真值不覆盖）：
  `identifiers`（exe/裸名候选）、`aliases`、`category` 关键词猜、`platforms` 桌面集；
  `stars/forks` 有限数字保留。
- 校验内联化：逐框 `onChange/onBlur` 即时校验，缺项不 toast 只标框下；
  收录/提交按钮可点（有错则定位首错行），后端二次校验保留。
- 简介随应用语言切换（`resolvePendingDraftDescription`，空回退另一语言）。

## 3. 状态机与分组（两轴）

库内归属：`draft` → `collected`/`local_collected`、`submitted`（在库）→ `archived`（退出库，权威交还远端）
上游进度：无 → `submitted`（已提交 Issue，待收录）→ `archived`（已收录，转正）

- 顶层 Tab：草稿 / 本地收录 / 已归档；「本地收录」内部分段：全部 / 待提交 / 已提交。
  切 Tab/分段重置选中/表单/报错并联动底部控件；计数按 Tab 分区不重计。
- 批量栏只在「本地收录」且分段非已提交时出现（多选 + 右下批量提交）；`submitted` 不可勾选。
- 草稿态：表单 + 收录主按钮（右置主样式），无“提交 Issue”；
  库内后链路（collected/submitted/archived）：一律富卡（`AppCard` + 黄标），不再出现参数表单；
  `submitted` 只展 Issue 链接 + 标记为未提交；`archived` 只读 + 复制为新草稿。
- 门禁：draft 不可直接提交 Issue（前后端同口径 `须先收录进本地再提交 Issue`）；
  二次提交/重收录对 submitted 硬拦；submitted 可删；`retire_on_sync` 按远端命中归档（submitted 同样命中）。
- 退回草稿：仅 `collected` 可 `revert_collected_to_draft` 落盘（`status=draft + pr_url` 清空），
  前端命令名必须用规范名（曾因 `revert_collected_app` 不一致致重启回潮）；退回后停留收录页不跳 Tab。
- 标记为未提交：`withdraw_submitted` 落盘（`status=collected + pr_url` 清空，payload 不动），
  行回到待提交、批量重新可选；Issue 需用户在 GitHub 自行关闭。

## 4. 本地库对齐与黄标

- 库内成员（收录态 + `submitted`）行为同正式收录：可搜可装，进合并流；库存恒 `is_verified=false`；
  Issue 预填载荷翻 `is_verified=true`（前后端 `normalize/toOrdered` 处）。
- 库内判定唯一口径 `isLocalLibraryStatus`（收录态 + submitted）；可提交 Issue/可退回的门禁仍用 `isCollectedStatus`。
- 黄标口径：`resolveVerifiedBadgeVariant`（蓝优先，黄认 `source=local` 或库内 `status`），
  复用 `verified-badge-local` 样式；覆盖首页/搜索/详情/收藏/趋势/最近浏览/收录富卡；
  首刷 `customApps=null` 不得误判无标，就绪后重标。
- 归档：同一 canonical id 权威切换（local → remote），首页单卡、黄转蓝、本地行不参与合并/计数/搜索；
  远端未验证则归档后无来源标（不引入第三徽标）；catalog 后续下架不回补已归档本地行。

## 5. 提交 Issue 流程（手动确认）

- 点提交：许可门禁 → 预检 → 复制 JSON →（超 8000 字符提示分批）→ 打开 Issue 预填页；
  不自动 mark，取消即停留收录态可重提；贴 Issue URL 点“我已提交”才进已提交。
- 打开通道：直调后端 `open_url` 成功即返，失败走劫持前原生 `window.open` 兜底并判 `null`；
  真失败 toast + 降级复制 URL，不谎报。

## 6. 非功能约束

- Linear 去彩单色：只文本层级 + 边框 + 单色图标；无新长文案（复用 `pending.errors/*`）。
- 测试门禁：`cargo test custom_apps` + `cargo test catalog_custom`、
  `pnpm vitest run PendingView.test/pr.test + ipcArgsNaming + noDirectInvoke`、`tsc --noEmit` 全过。

## 7. 已知风险备忘（hang 排查结论）

- 退出码 `0xCFFFFFFF` = 卡死后被杀非真崩溃；偶发 hang 主疑
  前端渲染风暴 × IPC 放大 × `Mutex<DB>` 串行共振；抓现场用转储 + `RUST_BACKTRACE=1 --verbose`。
