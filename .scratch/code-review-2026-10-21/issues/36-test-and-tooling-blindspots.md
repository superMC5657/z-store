# Issue 36: 测试与工具链盲区

Status: resolved
Priority: P3（质量基建）
来源: 2026-10-21 全项目审查 · services 分片

## 描述

1. **零测试的 hooks**：`src/app/hooks` 7 个（useSearchState / useInstallState /
   useDeepLink / useAppSubscriptions / useUpdateActions / useDetailCacheSync /
   usePlatformBackfill）；`src/lib/z-log.ts` 前端脱敏镜像（与后端 redact 同规则）零测试。
2. **views 覆盖缺口**：22 个视图文件无同位测试（useTrendBoard/useTrendEnrichment、
   SettingsView 各 section、InstalledView 等）。
3. **fixtures 维度**：`tests/fixtures/draft-validation-cases.json` 21 例，无
   aliases / platforms / identifiers / install_dirs 维度样例。
4. **CI/工具链**：vitest.config.ts 无 coverage 配置，CI 出不了覆盖率；`catalog.json`
   种子仅 `include_str!` 打包（config.rs:531），本仓库与 CI 均无种子 schema 校验（校验流
   在外部目录仓库），漂移只能运行时解析失败暴露。
5. Rust 侧 oauth/deeplink/installer/mirror 均有覆盖；唯 db/schema.rs 迁移无直接测试
   （db/tests.rs 32 例间接覆盖）——与 22 号工单迁移机制联动。

## 修复方向

- 按风险排序补测：z-log 镜像（安全语义）→ useDetailCacheSync/useDeepLink（有已知竞态
  史，见 17/18 号相关）→ 其余 hooks。
- vitest 加 coverage（@vitest/coverage-v8）并在 CI 输出阈值报告。
- 种子 catalog.json 接入与外部仓一致的 schema 校验（CI 步骤或构建期测试）。

## Comments

### 2026-10-21 批次 13 实施（全部落地，含一处安全修复）

**1. z-log 镜像测试 + 一处真实脱敏缺口修复（`src/lib/z-log.ts`）**

- 补测时发现前端 redact 与后端 `z_log.rs` 存在真实分歧：**JSON 紧凑/宽松形态
  `"code":"v"` / `"api_key":"sk"` 前端漏脱敏**（键与 `:` 之间的 `"` 使
  `\s*[:=]` 匹配失败），而后端 `test_redact_email_code_apikey` 明确锁定该形态必须
  打码。已修：键值正则键后补 `["']?`（与后端 `is_kv_post` 含引号对齐），顺带覆盖
  `code='v'` 单引号形态。只增不减的打码面，既有形态（`code=`/`code: `）零变化，
  `vscode` 路径守护回归通过。前端生产代码变化仅此一处。
- 新增 `src/lib/z-log.test.ts` 13 例：标记形态（四拼写+分隔符截断）、键值形态
  （含 JSON 形态、键名大小写保留）、vscode 路径守护、邮箱、宽字符不断裂、
  `[sid=][req=]` 前缀、1s 去重窗、`initZLog` 全局错误钩子脱敏与幂等。

**2. 七个 hooks 同位测试（新增 75 例，全部 renderHook + tauriApi Proxy mock）**

- `useDetailCacheSync.test.tsx` 13 例（竞态史优先）：0ms 快照命中、后台静默探查
  同值返回 prev/变值平滑覆盖、**A 慢 B 快迟到回包不覆盖选中态**、占位简介不污染
  （富卡治愈/无富卡存 ''）、stale 不碰平台、确认 other+富卡事件、平台治愈事件扇出、
  图标三态（http 写透 / data: 永不进盘+remote_url 唯一落盘真值 / 非 L5 data: 不落 /
  L5 显式空徽章）、loadError 落地。
- `useDeepLink.test.tsx` 8 例：五类动作路由、install_app 只暂存绝不自动安装（RCE
  守卫）、open_view 非法静默、失败 error toast、window 挂载点挂/卸对称、CLI 深链拉起。
- `useSearchState.test.tsx` 14 例：本地路由+跳视图、seq stale 守卫、同词在线集早退、
  提交即在线（20/页、满页 hasMore）、在线空/失败保持本地、翻页去重追加+失败复位、
  回声窗纯函数三语义。
- `useInstallState.test.tsx` 13 例：安装成功去重替换、在途去重、D3 门禁挂起待确认
  （非失败态）、取消/失败双路、卸载/启动/取消管理/刷新、installed 视图自动加载与
  错误态区分。
- `useUpdateActions.test.tsx` 8 例：单项更新、忽略取目标行版本、跳过/锁定/隐藏/
  移除/清除/双 toggle 写后重读、批量混合成败保留失败者、手动检查 force+DB 快照
  优先、空结果 all_latest、finally 复位。
- `usePlatformBackfill.test.tsx` 8 例：目标选择（具平台/已确认跳过）、三列表只回填
  空平台行、确认 other、stale seq 整批丢弃、在途去重、forceRefresh 透传、首绘自动
  回填、15s settle 降级确认 Other。
- `useAppSubscriptions.test.tsx` 11 例：初始拉取扇出+黄标叠加、`MANUAL_ONLY_NETWORK`
  门禁下 startup 不自动检查（见下）、catalog-synced 重拉+重标、图标升级回声窗立期望
  +四列表写透、watch 提醒+去重、更新流 upsert/进度/复位、OAuth 过期警示+派发、
  data-imported 全量回放、**C3 迟到订阅卸载后立即解绑**。
- 实施注记：`update_frequency='startup'` 自动检查分支在当前产品门禁
  （`lib/manualOnly.ts` `MANUAL_ONLY_NETWORK = true`）下不可达；测试按真实契约锁定
  并注明门禁翻转时随行翻转。维护者若确认该分支永久废弃，可另开清理工单。

**3. coverage 接入（`vitest.config.ts` + `pnpm test:coverage`）**

- `@vitest/coverage-v8@3.2.7`（与 vitest 同版本）；reporter `text+html+lcov`，
  include `src/**`，exclude `src/demo/**`、类型声明；`coverage/` 已进 `.gitignore`。
- 首次报告（870 例）：**全量语句 77.64% / 分支 74.7% / 函数 70.58% / 行 77.64%**。
- **给维护者的阈值建议（未强制，待拍板）**：全局起步建议 `statements/lines ≥ 75`、
  `branches ≥ 70`、`functions ≥ 65`（当前值略高于线，防立即红）；稳定后可按目录
  收紧（services/lib 已普遍 >85%，views 薄弱段 InstalledView ~68%、SettingsView
  ~68% 可作下一批补测目标）。

**4. 种子 catalog.json schema 校验（构建期，`config.rs` 新测试）**

- `embedded_seed_catalog_matches_runtime_schema`：`include_str!` 嵌入种子直接
  反序列化为运行时 `CatalogItem`（字段漂移在测试期暴露，运行时解析失败前移），
  再锁结构不变量：id 唯一、id==小写 `owner/repo`、六个展示字段非空、
  platforms/identifiers 键恒在五平台集合、别名条内唯一且不与 id 重合。
  不变量先对 362 条现状数据画像验证后才落锁（只锁真实契约）。
- 运行 `cargo test` 即生效（构建期测试口径，无需独立 CI 步骤）；CI 已跑 cargo test。

**5. db 高版本库只读兼容分支直测（`db/schema.rs`，与 22 号机制联动）**

- `higher_version_db_stays_readonly_without_downgrade_stamp`：`user_version=99`
  打开 → 不降级盖章 + 幂等基底照常补表。此前该分支无直接测试（批次 7 已落
  fresh/legacy 两例，本批补齐第三分支）。

**6. fixtures 维度样例（`tests/fixtures/draft-validation-cases.json` 21→25 例）**

- 新增 4 例携带 `aliases/platforms/identifiers/install_dirs`（含 publishers/
  search_subdirs）：submit 全维度通过、维度存在时大写 id 仍阻断 identity、
  维度存在时空 name 仍阻断 name、draft 维度-only 宽松通过。
- 关键前提：两侧门禁本就不校验这些维度；两侧 parity harness
  （`PendingView.validationParity.test.ts` + `db/custom_apps.rs`）同步透传维度
  字段，锁定"维度存在不改变 ok/首错序"这一双端一致契约。

**验证**：`pnpm vitest run` 870/870（84 文件，原 778 + 新增 88+4 parity 样例）；
`pnpm build`（tsc + vite）绿；`src-tauri cargo test` 368 过（原 366 + 2 新测试，
3 ignored）；`cargo clippy --tests -- -D warnings` 绿。
