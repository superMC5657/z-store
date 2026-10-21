# z-store 代码审查合并终稿

- 合并日期：2026-09-20
- 表述语言：中文
- 输入文档（三份，范围均为全树现状）：
  - A：`2026-09-20-full-review.md`（opencode-musespark1.3，双轴：Standards 14 项 + Spec 9 项）
  - B：`2026-09-20-reviewer-findings.md`（codex-glm5.3flash，分级 P0×2 / P1×5 / P2×8 / P3×3，共 18 项）
  - C：`CODE_REVIEW_REPORT.md`（Antigravity-gemini3.8flash，分级 P0×3 / P1×5 / P2×3，另有架构亮点与整改表）
- 方法偏差（三份共同）：仓库非 git 仓库，无增量 diff，均为全树现状审查；无正式 spec（`docs/agents/issue-tracker.md`、`.scratch/` issue、`CONTEXT.md` 缺失），Spec 类结论依据的是隐式契约（`types` + `catalog.json` + 路由 + 后端命令 + capability）。
- 去重结果：去重后共 **28 项**（含 4 项架构亮点）；三份共同命中的 **5 项**见 §0；两份命中的 **6 项**在正文中以「来源」标注；其余为单份独有发现。

## §0 三份一致的发现（共识最高，优先修）

| # | 问题 | A | B | C |
|---|------|---|---|---|
| 1 | 版本比较误报（非 semver + 预发布倒置） | ✔ | ✔(#13) | ✔(§3.2) |
| 2 | 前端测试环境不可复现（缺依赖/缺脚本/缺 jsdom） | ✔ | ✔(#3) | ✔(§4.3) |
| 3 | 备份导出静默丢失设置字段 | ✔ | ✔(#12) | —（C 未覆盖；A+B 一致） |
| 4 | `App.tsx` 上帝组件（1300+ 行、28~30 个状态） | ✔ | — | ✔(§4.1) |
| 5 | 深链静默安装 RCE / 便携卸载误删（B+C 一致的最严重两项，A 未覆盖） | — | ✔(#1,#2) | ✔(§2.1,§2.2) |

> 注：第 3 项为 A+B 一致，第 5 项为 B+C 一致；真正三份全中的是第 1、2 项。下方正文按严重度合并，去重后不再重复列示。

---

## P0 —— 安全与数据灾难（立即修，2+1 项）

### P0-1 深链免确认静默安装 → 一键 RCE（来源：B#1 + C§2.1）

- 位置：`src/App.tsx:704-706`、`src-tauri/src/deeplink.rs:67-75`
- 问题：`zstore://install/...` 直接派发到 `handleInstallApp`，无二次确认即下载并执行 Release 安装器；外部网页/聊天消息/iframe 可触发。
- 修复：深链 `install` 意图只打开详情页或确认弹窗；展示应用名、仓库、下载源与 SHA-256，要求用户显式点击确认后才安装。（C 建议可直接参考）

### P0-2 便携版卸载可递归清空共享父目录（来源：B#2 + C§2.2）

- 位置：`src-tauri/src/commands/installer.rs:311-329（C 标至 330）`
- 问题：卸载 `portable_zip` 时取可执行文件父目录，仅以后缀黑名单（`program files`/`windows`/`users`/`desktop`）过滤即 `remove_dir_all`；应用若解压在 `Downloads`、`D:\Tools` 等共享目录，整个目录被清空。
- 修复：仅允许删除 Z-Store 自建的隔离目录（如 `%LOCALAPPDATA%\Programs\z-store-apps\<app_id>`）；其余路径只删解压清单记录的文件，或拒绝删除。

### P0-3 Unix 卸载命令 `sh -c` 拼接注入（来源：B#15 + C§2.3，分级分歧：B 列 P2、C 列 P0-Medium）

- 位置：`src-tauri/src/installer/executor.rs:666-671（C 标 668-670）`
- 问题：卸载命令字符串取自数据库/外部收录源，直接传给 `sh -c`，`;`、`&&`、`|`、反引号可注入任意命令。
- 定级说明：按注入可达性定 **P0-3（最低 P1 起步）**，不接受 B 的 P2 定级。
- 修复：解析为程序+参数列表执行，或对已知 Unix 卸载入口用 allowlist，避免经过 shell。

---

## P1 —— 功能正确性 / 后端核心（6+5 项）

### P1-1 版本比较逻辑错误（来源：A + B#13 + C§3.2，三份全中）

- 位置：`src-tauri/src/commands/updates.rs:220-240（C 标至 254）`
- 三个子问题各有侧重，合并如下：
  1. **非 semver 误报**（A）：按 `.-_` 切分取前导数字，`tip` → 空（任何变化都算"有更新"），`v26.02-v1.5.7-R2` 的 `R2` 被当数字段比较。
  2. **预发布倒置**（C）：丢弃文本预发布段，`1.0.0-beta.1` 解析为 `[1,0,0,1]` 高于正式版 `[1,0,0]`，稳定版用户会被提示"更新"到测试版。
  3. **数字后缀误读**（B）：`R2` 类后缀被当作额外数字组件。
- 修复：引入 `semver` crate 做 SemVer-aware 比较，并为非 SemVer tag 定义明确行为（A/C/B 一致建议）。

### P1-2 MS-SHLLINK（.lnk）偏移解析错误（来源：B#5 + C§3.1）

- 位置：`src-tauri/src/scanner/resolver.rs:46-60（C 标 47-65）`
- 问题：把 flag `0x01`（`HasLinkTargetIDList`）当作 `LinkInfo` 依据并假设偏移 76；实际 `LinkInfo` 由 `0x02` 控制，且 IDList 存在时须跳过 `76 + 2 + id_list_size`。现有 fixture 两 flag 并存，结构化解析误读 IDList 字节，仅靠启发式 fallback 兜底。
- 修复：正确处理两 flag，先跳 IDList 再读 LinkInfo。

### P1-3 仓库验证未校验 owner 身份（来源：B#6，独有）

- 位置：`src-tauri/src/commands/forge.rs:315-324`
- 问题：`verify_ownership` 只要 README 出现调用者自选字符串即标已验证；UI 声称仅原作者可验证，后端接受任意调用者。
- 修复：要求匹配 owner 的 GitHub token，并经 repository API 校验所有权或 collaborator/write 权限。

### P1-4 便携 `.7z` 宣传支持但无法提取（来源：B#4，独有）

- 位置：`src-tauri/src/installer/executor.rs:150-156`
- 问题：`classify_asset` 把 `.zip`/`.7z` 都映射为 `PortableZip`，提取器恒用 `zip::ZipArchive` 打开，`.7z` 必然失败。
- 修复：二选一——停止宣传 `.7z` 支持，或接入受支持的 7z 提取实现。

### P1-5 无兼容资产时 fallback 安装错误平台包（来源：B#10，独有）

- 位置：`src-tauri/src/commands/installer.rs:61-75`
- 问题：`select_best_asset` 找不到当前 OS 资产时回落到全部资产；Windows 用户可能选中 `.deb`，收到 `Ok("当前平台跳过 deb 安装")` 却被记为已安装，实际无可执行文件。
- 修复：无兼容 OS/arch 资产时安装必须失败。

### P1-6 外部/多 forge 应用平台元数据写死 windows（来源：B#11，独有）

- 位置：`src-tauri/src/commands/catalog.rs:36-60`
- 问题：外部 GitHub 与 Codeberg/Gitea/GitLab 搜索结果硬编码 `platforms: ["windows"]`，即使 Release 含 Linux/macOS/Android 资产或根本无 Windows 资产；破坏全局平台过滤与非目录应用资产选择。
- 修复：从可用资产推导平台标签；允许空列表，但空列表必须被明确处理。

### P1-7 导入时跳过已安装应用的收藏/关注（来源：B#7，独有）

- 位置：`src-tauri/src/commands/history.rs:124-144`
- 问题：同机恢复备份时，已安装应用的收藏与关注关系被跳过；安装状态不应影响独立用户数据的合并。
- 修复：已安装状态只影响安装类导入；收藏/关注正常合并。

### P1-8 备份 schema 覆盖不足（来源：A + B#12）

- 位置：`src/components/DataBackupRow.tsx:30-40`、`src/types/index.ts:130-146` vs `:324-329`
- 问题：UI 承诺恢复偏好，但仅导出 4 字段（`theme`/`language`/`detail_cache_ttl_minutes`/`watch_notify_frequency`）；B 进一步列出遗漏：`ui_scale`、`font_size`、`portable_dir`、`download_dir`、`active_mirror`、并发数、托盘/开机行为、更新频率、catalog source。导入后端且无与 `language` 对应的类型（B#17 相关）。
- 修复：扩展带版本的备份 schema，或收敛 UI 承诺；敏感字段（如 GitHub token）若刻意排除须文档说明。

### P1-9 前端测试资产休眠、构建不可复现（来源：A + B#3 + C§4.3，三份全中）

- 位置：`package.json:7-14`、`App.platformFilter.test.tsx:9,49`、`HomeView.test.tsx:18-19`
- 合并：7 个测试文件存在，但缺 `test` 脚本、无 `vitest.config.*`、缺 `vitest`/`jsdom`/Testing Library 依赖；Node 环境直跑 54 个测试因 `document/window is not defined` 失败（B）；且代码用 `// @ts-ignore` 掩盖缺依赖而非声明 devDeps（A，Hard）。
- 修复：加 `"test": "vitest run"` + `environment: "jsdom"` 配置 + 显式 devDependencies（B/C/A 一致）。

### P1-10 下载流阻塞 Tokio + 频繁重建 HTTP Client（来源：C§3.3 + §3.4，独有）

- 位置：`downloader.rs:244`（`std::fs::File` + `write_all` 在异步循环内）；`updates.rs:117-120`、`oauth/device_flow.rs:9-13`、`oauth/star.rs:18-24`（每次重建 `reqwest::Client`）
- 问题：同步写独占 Worker 线程致 IPC/进度/UI 卡顿；Client 频繁丢弃致连接池与 TLS 会话缓存失效，批量查更新时握手开销大。
- 修复：`tokio::fs::File` + `AsyncWriteExt`；`AppState` 内单一共享 `reqwest::Client` 注入复用。

### P1-11 全局 SQLite 锁竞争（来源：C§3.5，独有）

- 位置：`commands/catalog.rs:203-300`
- 问题：所有读写串行于单一 `Arc<Mutex<Database>>`，`get_app_details` 等链路单次请求多次加锁释放，锁颠簸。
- 修复：合并单请求 DB 交互；WAL 已开，后续可引入连接池（如 `r2d2_sqlite`）读写分离。

---

## P2 —— 前端架构 / 状态与数据完整性（9 项）

### P2-1 `App.tsx` / `AppDetailModal.tsx` 上帝组件（来源：A + C§4.1）

- 位置：`App.tsx`（1375/1376 行，约 28~30 个 `useState`/`useRef`）、`AppDetailModal.tsx`（1304 行，约 15 个 `useState`）
- 问题：下载进度、更新检查、Toast、深链路由、模态框可见性混杂；高频小状态变更触发全树重 Diff（C）；安装/star/verify/markdown 多职责一体（A，Divergent Change）。
- 修复：引入 zustand 拆分 `useDownloadStore`/`useToastStore`/`useSettingsStore`（C）；弹窗按职责拆分（A）。

### P2-2 `api.ts` 薄封装 + 动态 import 开销 + 守卫缺失（来源：A + C§4.2）

- 位置：`src/services/api.ts:49-55, 57-422`（约 60 个单行 `tauriInvoke` 包装）；`:209` `onDownloadProgress` 缺 `if (!isTauri)` 守卫（同文件 `:99,:107` 有）
- 问题：每次调用 `await import('@tauri-apps/api/core')` 增加微任务开销且 Vite 报动静混用告警（C）；纯委托 Middle Man（A，判断性）。
- 修复：静态引入 + Adapter 切分 Web 预览（C）；补 `:209` 守卫（A）。

### P2-3 平台过滤未全局生效（来源：A + B#9）

- 位置：`App.tsx:1106`（`platformFilteredApps` 仅喂 Home/Trends/Categories；`1238` Favorites 用未过滤 `apps`，Installed/Updates 同）；`history.rs:54-65`（`recentlyViewedApps` 未过滤直传 `HomeView`）
- 问题：A 与 B 各发现一处，实为同一"全局过滤承诺未兑现"的两面。
- 修复：Favorites/Installed/Updates 与最近浏览统一经 `matchPlatformSet` 过滤。

### P2-4 双份 `parseSelectedPlatforms` 语义相反（来源：A Standards + A Spec，A 独有）

- 位置：`App.tsx:33`（缺失/损坏回落**全集**）vs `lib/platformFilter.ts:99`（`null` 回落**空集**）
- 问题：同名函数空语义相反；测试只覆盖 lib 副本（`App.platformFilter.test.tsx:11-15`），`App.platformGuard.test.tsx:19-45` 全 mock `api.*`，真实 `search_apps` 路径无覆盖。
- 修复：收敛为单一实现并明确空语义；补端到端覆盖。

### P2-5 忽略更新未持久化（来源：A，独有）

- 位置：`App.tsx:933-936`（`handleIgnoreUpdate` 仅 `setUpdates(filter)`）vs `:939-945`（`handleSkipVersion` 调 `api.setAppSkipVersion`）
- 问题：忽略项下次 `checkForUpdates` 即恢复。
- 修复：与 skip-version 同链路持久化。

### P2-6 每日更新轮询未实现（来源：B#8，独有）

- 位置：`src/views/SettingsView.tsx:366-381`
- 问题：设置暴露"每 24 小时轮询"，但启动仅 `startup` 模式检查；无前端定时器、无后端调度器，选 daily 的用户仅打开 Updates 页签才看到检查。
- 修复：实现 24h 定时/调度；在支持前禁用该选项。

### P2-7 批量安装失败卡死按钮（来源：B#14，独有）

- 位置：`src/views/FavoritesView.tsx:88-97`
- 问题：`handleBatchInstallAll` 循环无 `try/finally`，单个失败使 `isBatchInstalling` 恒 true，"一键批量装机"永久禁用且无错误汇总。
- 修复：逐个捕获并始终重置 loading，汇总错误。

### P2-8 趋势榜伪造时间序列（来源：A，独有；scope creep）

- 位置：`TrendsView.tsx:56-59`
- 问题：`catalog.json` 的 `stars/forks` 为静态快照，却按 `(forks*3 + stars%500)` 排序并配 day/week/month 档，虚构出"动量"语义。
- 修复：改为快照排序并如实标注，或接入真实时间序列后恢复分档。

### P2-9 capability 权限契约缺口（来源：A，独有）

- 位置：`capabilities/default.json:6-19`（仅 `core:window/*`、updater、log）vs `api.ts:319 select_folder`、`413 open_url`、`ClientUpdateRow.tsx:35` updater `check()`
- 问题：dialog/opener/deep-link 所需权限未声明。
- 修复：补声明缺失权限并回归验证。

---

## P3 —— 一致性 / 文案 / 结构小异味（8 项）

- **P3-1 fallback hero 文案串台**（B#16）：`HomeView.tsx:132-151`，RustDesk 被过滤后 hero 换应用，标题仍"开源远程桌面"。修复：通用文案兜底，专属文案仅 RustDesk 为 hero 时显示。
- **P3-2 默认设置缺 `language`**（B#17）：`settings.rs:8-27` 无 `language` 默认值，但备份类型引用、前端接受，语言无法完整往返。修复：补后端默认值或从备份 schema 移除。
- **P3-3 catalog source 信任模型缺失**（B#18，B 列 P3，此处保留但提示可上调）：`github/catalog.rs:65-101` 接受任意 HTTP(S)/本地路径，无来源验证即可替换可信目录。修复：allowlist/签名目录/高摩擦确认。
- **P3-4 客户端自更新为编外功能**（A，scope creep，信息项）：`ClientUpdateRow.tsx:35-48` + `tauri.conf.json:48-54`，`types`/catalog 无对应字段。建议：确认为正式需求并补契约，或降级为可选。
- **P3-5 类型与结构小异味合集**（A，均为判断性）：`AppDetailModal.tsx:29-51` 17-prop Data Clumps；`platformFilter.ts:66` `matchPlatformSet`/`normalizePlatform` 取 `string` 而已有 `PlatformId`（Primitive Obsession）；`AppDetailModal.tsx:286-299` `currentOs`/`currentArch` 双 `userAgent.includes` 级联（Repeated Switches）；`z-log.ts` 未使用的 `ZLogOptions{batch?,flushIntervalMs?}`、no-op `flush()`、`initZLog(_opts)`（Speculative Generality）；`z-log.ts:11 let inited`、`sanitize.ts:26 resolveRelativeUrl`（Mysterious Name）；`fluent.css` 3121 行单体；`build-latest-json.mjs:31-34` 无边界检查的参数解析。
- **P3-6 规范缺失本身**（A，gap 非代码违规）：无 `CODING_STANDARDS.md`/`CONTRIBUTING.md`/`CONTEXT.md`/`docs/agents/*`；`AGENTS.md:9,13,17` 三处悬空引用。建议运行 `/setup-matt-pocock-skills` 补齐。

---

## 架构亮点（来源：C§5，保留；其中第 1 项与 A 的 sanitize 收紧意见并存而不矛盾）

1. **DOMParser 白名单 XSS 净化**（`sanitize.ts`）：AST 级审查、清内联事件、阻断 `javascript:`、外链强制 `rel="noopener noreferrer"`。**保留肯定，同时采纳 A 的收紧意见**：`ALLOWED_TAGS` 含 `video/audio/source/picture`、`sanitize.ts:95` 仅拦 `data:text/`（放行 `data:image/svg`）超出 README/changelog 渲染所需，建议收紧 allowlist。
2. **流式下载 SHA-256 校验**（`downloader.rs`）：边下边算哈希，异常拦截预警。
3. **日志脱敏**（`z_log.rs`）：Bearer Token/GitHub 凭据/邮箱脱敏，限保留周期与体积。
4. **多源 Forge 抽象**（`forge/`）：GitHub/GitLab/Gitea-Codeberg 统一坐标系。

---

## 建议处理顺序

1. **P0 三项**：先堵 RCE 与数据丢失（深链确认、卸载目录白名单、shell 注入）。
2. **P1 后端与数据**：版本比较（semver）→ .lnk 解析 → 资产选择/平台推导 → owner 验证 → 导入/备份 → 测试环境恢复（P1-9 可与 P0 并行先行，因其阻塞回归验证）。
3. **P2 状态与架构**：平台过滤全局化 → 忽略更新持久化 → 每日轮询/批量安装 → 上帝组件拆分 → Client/API 优化。
4. **P3 收尾**：hero 文案、language 默认、catalog 信任模型评估、规范文档补齐。

## 去重对照（审计用）

- 三份全中：版本比较、测试环境。
- A+B：备份覆盖不足。
- B+C：深链 RCE、便携卸载误删、shell 注入、.lnk 解析。
- A+C：上帝组件、api.ts 问题、sanitize（C 褒、A 收紧，结论合并）。
- 仅 A：双 parse 分歧、忽略更新未持久化、每日轮询（否，B）、趋势伪造、capability 缺口、自更新 scope、结构小异味、规范缺失。
- 仅 B：owner 验证、.7z、资产 fallback、平台推导、导入跳过、每日轮询、批量安装、hero 文案、language 默认、catalog 信任。
- 仅 C：tokio 阻塞 IO、Client 复用、SQLite 锁、亮点章节。
- 分级分歧：shell 注入（B:P2 / C:P0-Medium → 本稿 P0-3）；catalog source（B:P3 → 本稿 P3-3，标注可上调）。

---

## 附录 R —— 全部修复执行记录（2026-09-20/21）

- 执行方式：Plan Agent 拆解为 30 个文件级单元（U01-U30），按 5 波执行（Wave1:13 并行 → Wave2:8 并行 → Wave3:4 并行 → Wave4:App.tsx 串行链 → Wave5:U28→U24），每单元 TDD 红→绿 + 逐件验证。
- 产品决策（已按默认执行，如需推翻请指示）：P1-4 去 `.7z` 宣称（不引入 7z 依赖）；P2-6 禁用 `daily` 选项（不做真调度器）；P3-3 高摩擦确认（不做签名基建）；P3-4 承认自带更新并补契约；P2-1 拆分不用 zustand（零新依赖）。
- P2-9 最终裁决：**误报，无需修复**（U23 只读验证：`select_folder`/`open_url` 为自注册命令，Tauri 默认放行 + `build.rs` 无限制；`updater:default` 已含 `allow-check`；官方文档引证存档于单元报告）。
- U04 保守权衡：混合可解析/不可解析版本对一律返回 false（文档化），不可解析 tag 宣告的升级不会提示；放宽只需动 `_ => false` 分支。
- U24 诚实收尾：`App.tsx` 1489→1317 行、`AppDetailModal.tsx` 1304→1129 行；弹窗内安装/下载进度状态因与 6+ JSX 分支交织而有意保留，为后续单元。
- P3-6 更正：**该项误报**。`docs/agents/issue-tracker.md`、`triage-labels.md`、`domain.md`、`CONTEXT.md`、`docs/adr/`（10 篇 ADR）、`.scratch/` 各 feature 目录实际存在；审查时的"缺失"结论源于过期的目录视图。真正缺失的仅 `CODING_STANDARDS.md`/`CONTRIBUTING.md`。`AGENTS.md` 引用不悬空。
- 版本库说明：`.git` 实际存在且有提交历史；本次 30 单元的所有修改均为**未提交的工作区变更**（遵"不主动提交"约束），`git status` 可查；未做任何 commit。
- 终验（全部亲跑）：`cargo test` 106 通过/0 失败/3 忽略（忽略项为既有主机依赖扫描测试）；`cargo build --offline` 成功；`pnpm test` 18 文件/119 用例全绿（基线 7 文件/79 用例）；`pnpm build`（严格 tsc）成功，仅既有 chunk-size 告警；`src/` 内 `as any`/`@ts-ignore`/`@ts-expect-error` 零命中。
