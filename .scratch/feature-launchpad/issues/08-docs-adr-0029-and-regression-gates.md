# Issue 08: ADR-0029 架构决策记录、领域词汇文档同步与全量回归门禁验收

Status: ready-for-agent
Blocked by: 04, 05

## Summary

完成「开源广场（Launchpad）」特性的架构决策归档（`ADR-0029`）、领域模型与规范文档同步更新，并执行客户端全套静态检查、单测与官网在线演示构建门禁验收。

## Scope

- Allowed to modify:
  - `docs/adr/0029-launchpad-social-discovery-and-isolated-manifest.md`（新增）
  - `CONTEXT.md`
  - `AGENTS.md`
  - `docs/count-display.md`
- Do not modify:
  - 已定稿的历史 ADR（仅在新 ADR 中交叉引用说明受控扩展边界）

## Implementation Details

### 1. 新增 `docs/adr/0029-launchpad-social-discovery-and-isolated-manifest.md`

记录以下核心架构裁决与取舍：
1. **双仓物理隔离决策**：为什么新品导流不写入 `z-store-catalog/catalog.json` 及本地 `catalog_apps` 表，而采用独立 `superMC5657/z-store-launchpad` 静态 `launchpad.json` + `launchpad_feed_cache` 二级快照 + 未收录 `repo_card_cache` 桥接；
2. **D1 纯粹开源与置顶赞助边界**：Spotlight（上限 4 坑位，`pin_until` 双端过期守卫，单色透明 `.status-tag` 标注）严格受同等 OSI 开源协议与构建资产门禁约束，零行为埋点、零主目录加权；
3. **零重授权的 GitHub Discussions 混合通道**：复用既有 `OAUTH_SCOPE = "public_repo user"` 实现 GraphQL 评论与双模顶帖（`addUpvote` 主路径 + `THUMBS_UP` Reaction 兜底），配合匿名 REST ETag 只读降级消除未登录用户的 GraphQL 401 门槛；
4. **与 ADR-0025 的镜像回退对齐**：`launchpad.default_source_url` 作为第二处无凭据公开静态清单源，支持首跳失败后的单次 `MirrorNode` 重试与严格规范 ID 校验。

### 2. 同步领域与工程规范文档

- `CONTEXT.md`：
  - 词汇表新增 **开源广场（`Launchpad`）**、**置顶推荐（`Spotlight`）**、**作者自荐语（`Maker Note`）** 标准术语定义；
  - 在 D1、D2、D4、D10 及双维目录筛选段落补充 `launchpad` 视图的隔离契约、平台分布上报与 `IconFetchCtx::Launchpad` 世代说明。
- `AGENTS.md`：
  - 在 `## Ecosystem Repositories` 下补充 **Launchpad (`superMC5657/z-store-launchpad`)**（配置源 `[launchpad].default_source_url`，详见 ADR-0029）。
- `docs/count-display.md`：
  - 在「一个视图里每个数字只出现一次」章节补充开源广场条目：「置顶推荐」与「最新上架」各自标题挂当前设备筛选下的 `<CountBadge>`，三档排序分段切换顺序而不重复挂数字；「置顶推荐」卡片标记归入 `.status-tag` 文字型状态标签。

### 3. 全量质量门禁执行清单

依次运行并确保零警告、零错误：
1. `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
2. `cargo test --manifest-path src-tauri/Cargo.toml`
3. `npx tsc --noEmit`
4. `npx vitest run`（重点核验 `countDisplay.test.ts`、`ipcArgsNaming.test.ts`、`cmdAlignment.test.ts`、`noDirectInvoke.test.ts`、`components.i18n.scan.test.ts`、`buttons.parity.test.tsx`、`navigation.test.ts`、`LaunchpadView.test.tsx`、`LaunchpadDiscussionDrawer.test.tsx`）
5. `npx vite build --config vite.demo.config.ts`

## Acceptance Criteria

- [ ] `ADR-0029`、`CONTEXT.md`、`AGENTS.md`、`docs/count-display.md` 术语一致，遵循「只描述当前系统行为、不写变更流水账」的文档规范。
- [ ] 上述 5 条全量构建与测试命令 100% 绿灯通过。
