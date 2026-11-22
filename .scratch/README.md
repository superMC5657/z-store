# ZStore Feature Specs & Issue Tracker 目录索引

> 本目录为 ZStore 项目的本地需求工单与技术规格索引（遵循 [`docs/agents/issue-tracker.md`](../docs/agents/issue-tracker.md) 与 [`AGENTS.md`](../AGENTS.md)），按执行时序汇总 **40 个特性与治理专题**及其演进取舍。

---

## 目录规范约定

- **单个特性对应单一目录**：`.scratch/<feature-slug>/`
- **核心规格文档**：`.scratch/<feature-slug>/spec.md`（或 `SPEC.md` / `plan.md`）
- **原子工单拆解**：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`（从 `01` 递增编号）
- **工单状态流转**：工单头部通过 `Status:` 标注状态（`needs-triage` → `ready` → `claimed` → `resolved`），遵循 [`docs/agents/triage-labels.md`](../docs/agents/triage-labels.md)
- **现状真相优先**：现行系统边界与领域定义以 [`CONTEXT.md`](../CONTEXT.md) 及 [`docs/adr/`](../docs/adr/) 为准；各专题的废弃、取代与裁撤取舍见下文「架构演进与取舍清单」。

---

## 执行时序全景速查表 (Master Execution Timeline)

| 顺序标识 | 研发阶段 (Phase) | Spec 目录 (Slug) | 专题 / 特性名称 | 落地时间 | 核心 Commit | 关联决策 (ADR) | 状态 |
| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **#01** | Phase 1: MVP 体系 | [`feature-mvp`](./feature-mvp/spec.md) | MVP 跨平台开源应用商店主体脚手架 | 2026-09-04 | `b9a5b82` | ADR-0001 ~ 0005 | 6 / 6 Resolved |
| **#02** | Phase 1: MVP 体系 | [`feature-multi-forge`](./feature-multi-forge/spec.md) | 多托管源生态拓展 | 2026-09-04 | `d8999bc` | ADR-0006 | 4 / 4 Resolved |
| **#03** | Phase 1: MVP 体系 | [`feature-app-import`](./feature-app-import/spec.md) | 系统存量开源软件扫描与纳管（匹配已由 #28 取代） | 2026-09-04 | `008596c` | ADR-0009 | 3 / 3 Resolved |
| **#04** | Phase 1: MVP 体系 | [`feature-update-ctrl`](./feature-update-ctrl/spec.md) | 细粒度版本更新控制与校验（见取舍备注） | 2026-09-04 | `9caefc9` | ADR-0004 | 3 / 3 Resolved |
| **#05** | Phase 1: MVP 体系 | [`feature-dev-ecosystem`](./feature-dev-ecosystem/spec.md) | 开发者画像与生态互动 | 2026-09-04 | `473a1c2` | ADR-0003 | 4 / 4 Resolved |
| **#06** | Phase 1: MVP 体系 | [`feature-deep-link`](./feature-deep-link/spec.md) | 系统协议唤起与多端原生引擎（见取舍备注） | 2026-09-04 | `8ff2772` | ADR-0001, 0004 | 4 / 4 Resolved |
| **#07** | Phase 1: MVP 体系 | [`code-review-2026-09-20`](./code-review-2026-09-20/code-review-report.md) | 全项目双轴代码审查与早期门禁治理 | 2026-09-20 | `de9762b` | ADR-0010 | 报告归档 |
| **#08** | Phase 2: 趋势与图标 | [`feature-trends-board`](./feature-trends-board/spec.md) | 开源趋势榜单与 L2 缓存治理 | 2026-10-04 | `1b0bbe8` | ADR-0011, 0014 | 6 / 6 Resolved |
| **#09** | Phase 2: 趋势与图标 | [`icon-fix`](./icon-fix/spec.md) | 本地图标缓存优先与打包图标退役（已由 #15/#24 演进取代） | 2026-10-10 | `a52a1d3` | ADR-0015 | 5 / 5 Resolved |
| **#10** | Phase 2: 趋势与图标 | [`pending-apps`](./pending-apps/SPEC.md) | 待收录应用生命周期管理与草稿流（批量 PR 已裁撤） | 2026-10-11 | `084156e` | ADR-0017 | 5 / 5 Resolved |
| **#11** | Phase 2: 趋势与图标 | [`architecture-deepening`](./architecture-deepening/plan.md) | 架构深度治理计划（核心深模块与规范标识） | 2026-10-11 | `fd70c4b` | ADR-0006, 0010 | 14 / 14 Resolved |
| **#12** | Phase 2: 趋势与图标 | [`code-review-2026-10-21`](./code-review-2026-10-21/execution-plan.md) | 10-21 深度代码审计与工单体系入库 | 2026-10-21 | `68bb2ff` | ADR-0018, 0020 | 48 / 48 Resolved |
| **#13** | Phase 3: 性能与缓存 | [`icon-l3-discovery-fix`](./icon-l3-discovery-fix/spec.md) | 富卡与详情页 L1~L4 图标探测一致性 | 2026-11-08 | `7f8f8a6` | ADR-0010, 0015 | 4 / 4 Resolved |
| **#14** | Phase 3: 性能与缓存 | [`perf-and-cache-hardening`](./perf-and-cache-hardening/spec.md) | 全链路性能治理与 HTTP/目录缓存加固 | 2026-11-10 | `e482f20` | ADR-0007, 0012 | 5 / 5 Resolved |
| **#15** | Phase 3: 性能与缓存 | [`icon-and-cache-local-first`](./icon-and-cache-local-first/spec.md) | 图标与富卡本地缓存优先及写透 | 2026-11-11 | `f80b164` | ADR-0003, 0019 | 6 / 6 Resolved |
| **#16** | Phase 3: 性能与缓存 | [`catalog-db-refactor`](./catalog-db-refactor/spec.md) | Catalog 清单与 SQLite 分层架构规范 | 2026-11-12 | `b76e1f7` | ADR-0017 | 规范已落地 |
| **#17** | Phase 3: 性能与缓存 | [`module-deepening`](./module-deepening/spec.md) | 全仓模块合并加深与浅层碎片清理 | 2026-11-12 | `675542e` | ADR-0004, 0018 | 9 / 9 Resolved |
| **#18** | Phase 3: 性能与缓存 | [`manage-ui-redesign`](./manage-ui-redesign/spec.md) | 管理中心（已安装 & 更新）UI 重设计 | 2026-11-12 | `92b3fe5` | ADR-0022 | 5 / 5 Resolved |
| **#19** | Phase 3: 性能与缓存 | [`button-size-and-inverted-icon-parity`](./button-size-and-inverted-icon-parity/spec.md) | 同级按钮尺寸统一与反色图标光学对齐 | 2026-11-13 | `d59aa1d` | — | 6 / 6 Resolved |
| **#20** | Phase 4: 本地推荐 | [`feature-local-affinity-recommendation`](./feature-local-affinity-recommendation/spec.md) | 本地用户画像与动态推荐一期（算法已由 #23 取代） | 2026-11-13 | `d5e9cd2` | ADR-0013 | 6 / 6 Resolved |
| **#21** | Phase 4: 本地推荐 | [`feature-featured-page-redesign`](./feature-featured-page-redesign/spec.md) | 精选页重设计（可解释的本地推荐货架） | 2026-11-14 | `94f9f68` | ADR-0023 | 10 / 10 Resolved |
| **#22** | Phase 4: 本地推荐 | [`feature-detail-homepage`](./feature-detail-homepage/spec.md) | 应用详情官方主页展示与单色视觉统一 | 2026-11-14 | `43515cd` | ADR-0001, 0010 | 3 / 3 Resolved |
| **#23** | Phase 4: 本地推荐 | [`affinity-algorithm-v2`](./affinity-algorithm-v2/spec.md) | 本地推荐算法二期（双源融合与货架轮换） | 2026-11-14 | `1943942` | ADR-0023, 0024 | 8 / 8 Resolved |
| **#24** | Phase 5: 管道收敛 | [`outbound-proxy-and-asset-convergence`](./outbound-proxy-and-asset-convergence/spec.md) | 系统代理动态感知与远端资产缓存收敛 | 2026-11-14 | `a4e7104` | ADR-0025 | 6 / 6 Resolved |
| **#25** | Phase 5: 管道收敛 | [`richcard-cache-and-pipeline-convergence`](./richcard-cache-and-pipeline-convergence/spec.md) | 搜索、Star 与趋势富卡缓存收敛（存储形态由 #26 演进） | 2026-11-15 | `3967910` | ADR-0026 | 6 / 6 Resolved |
| **#26** | Phase 5: 管道收敛 | [`unified-repo-card-and-index-caches`](./unified-repo-card-and-index-caches/spec.md) | 独立单仓富卡表与列表瘦索引水合 | 2026-11-15 | `b035d5d` | ADR-0027 | 6 / 6 Resolved |
| **#27** | Phase 5: 管道收敛 | [`view-counts-and-filter-consistency`](./view-counts-and-filter-consistency/spec.md) | 多视图数量显示与筛选口径全局对齐 | 2026-11-15 | `efbae62` | ADR-0021, 0022 | 6 / 6 Resolved |
| **#28** | Phase 6: 匹配与广场 | [`local-app-matcher-v2`](./local-app-matcher-v2/spec.md) | 存量应用匹配引擎 v2（倒排索引与边界打分） | 2026-11-16 | `b18fb19` | ADR-0028 | 5 / 5 Resolved |
| **#29** | Phase 6: 匹配与广场 | [`feature-launchpad`](./feature-launchpad/spec.md) | 开源广场（Launchpad）新品发现与社交互动 | 2026-11-16 | `537afed` | ADR-0029 | 8 / 8 Resolved |
| **#30** | Phase 7: 底座与优化 | [`unified-modal-shell`](./unified-modal-shell/spec.md) | 全站统一弹窗底座与语义层级规范 (`ModalShell`) | 2026-11-17 | `aef5439` | — | 2 / 2 Resolved |
| **#31** | Phase 7: 底座与优化 | [`backend-security-leaks-and-correctness`](./backend-security-leaks-and-correctness/spec.md) | 后端专题一：安装器安全、异步泄漏与规则健壮性 | 2026-11-17 | `430e222` | ADR-0004, 0028 | 3 / 3 Resolved |
| **#32** | Phase 7: 底座与优化 | [`backend-asset-icon-io-and-http-resilience`](./backend-asset-icon-io-and-http-resilience/spec.md) | 后端专题二：资产/图标缓存治理与 HTTP 重试收敛 | 2026-11-17 | `8e1fde2` | ADR-0012, 0025 | 3 / 3 Resolved |
| **#33** | Phase 7: 底座与优化 | [`backend-catalog-index-and-affinity-cache`](./backend-catalog-index-and-affinity-cache/spec.md) | 后端专题三：`CatalogService` 索引与画像预计算 | 2026-11-18 | `867a5d4` | ADR-0010, 0024 | 3 / 3 Resolved |
| **#34** | Phase 7: 底座与优化 | [`backend-sqlite-batching-and-async-offload`](./backend-sqlite-batching-and-async-offload/spec.md) | 后端专题四：SQLite 批量读写与阻塞 IO 异步卸载 | 2026-11-18 | `67f053e` | ADR-0003, 0027 | 3 / 3 Resolved |
| **#35** | Phase 7: 底座与优化 | [`backend-contract-consistency-and-hygiene`](./backend-contract-consistency-and-hygiene/spec.md) | 后端专题五：元数据校验、端点 SSOT 与构建卫生 | 2026-11-18 | `a5fb3b8` | ADR-0010, 0018 | 2 / 2 Resolved |
| **#36** | Phase 7: 底座与优化 | [`richcard-pipeline-optimization`](./richcard-pipeline-optimization/spec.md) | 在线搜索 / 趋势榜 / Star 富卡链路收敛与缓存治理 | 2026-11-20 | `b9a3137` | ADR-0011, 0015, 0027 | 5 / 5 Resolved |
| **#37** | Phase 8: 发现深化与生态工具 | [`feature-launchpad-preflight-and-badges`](./feature-launchpad-preflight-and-badges/spec.md) | 开源广场应用内投稿预检向导与 README 徽章生成器 | 2026-11-20 | — | ADR-0018, 0029 | 4 / 4 Resolved |
| **#38** | Phase 8: 发现深化与生态工具 | [`feature-shareable-collections`](./feature-shareable-collections/spec.md) | 可分享应用合集深链（`zstore://collection`）与批量预览安装 | 2026-11-20 | — | ADR-0001, 0004, 0010 | 4 / 4 Resolved |
| **#39** | Phase 8: 发现深化与生态工具 | [`feature-similar-and-alternatives`](./feature-similar-and-alternatives/spec.md) | 商业软件「开源平替」搜索增强与详情页「相似开源项目」推荐 | 2026-11-20 | `f41772f` | ADR-0023, 0024, 0030 | 4 / 4 Resolved |
| **#40** | Phase 8: 发现深化与生态工具 | [`module-deepening-v2`](./module-deepening-v2/spec.md) | 全栈深模块收敛与命令层去编排化二期（`AppDetail` / `CardHydrator` / `Launchpad` / `DemoStore`） | 2026-11-22 | — | ADR-0004, 0006, 0015, 0017, 0027, 0029 | 9 / 9 Resolved |

---

## 阶段演进摘要

### Phase 1: MVP 雏形与基础架构构建（2026-09-04 ~ 2026-09-20）

奠定 ZStore 跨平台（Windows / Linux / macOS）开源桌面商店的骨架，确立无中心化后端（Serverless Direct API）的核心约束。

#### #01 · `feature-mvp`
- **定位**：MVP 跨平台应用商店主体脚手架（6 / 6 Resolved）。
- **交付**：Tauri 2 + React + TypeScript + Linear 单色矢量图标界面底座（[ADR-0001](../docs/adr/0001-tauri2-and-react-fluent-architecture.md)）、GitHub 直连与镜像管道（[ADR-0002](../docs/adr/0002-direct-github-api-and-mirror-pipeline.md)）、SQLite 持久化与 ETag 缓存（[ADR-0003](../docs/adr/0003-sqlite-persistence-and-etag-caching.md)）、流式安装器与 SHA-256 校验（[ADR-0004](../docs/adr/0004-streaming-installer-and-checksum-verification.md)）。

#### #02 · `feature-multi-forge`
- **定位**：多托管源生态拓展（4 / 4 Resolved）。
- **交付**：抽象 `ForgeProvider`，支持 GitHub、Codeberg、Gitea/Forgejo 与 GitLab（[ADR-0006](../docs/adr/0006-multi-forge-ecosystem-support.md)）。

#### #03 · `feature-app-import`
- **定位**：系统存量开源软件扫描与纳管（3 / 3 Resolved）。
- **交付**：扫描本机已装软件并匹配精选目录以接管更新；**后续匹配算法由 `#28 local-app-matcher-v2` 取代**。

#### #04 · `feature-update-ctrl`
- **定位**：细粒度版本更新控制与完整性校验（3 / 3 Resolved）。
- **交付**：`update_rules` 表支持跳过版本、锁定版本与隐藏应用。
- **取舍备注**：早期设想的 Windows WinTrust Authenticode 数字签名校验未合入生产代码，安装包完整性校验统一收敛为基于 `Checksum Manifest` 的流式 SHA-256 校验（[ADR-0004](../docs/adr/0004-streaming-installer-and-checksum-verification.md)）。

#### #05 · `feature-dev-ecosystem`
- **定位**：开发者画像与生态互动（4 / 4 Resolved）。
- **交付**：开发者详情弹窗、GitHub Star 清单同步与本地浏览足迹记录。

#### #06 · `feature-deep-link`
- **定位**：系统协议唤起与跨端能力探索（4 / 4 Resolved）。
- **交付**：注册 `zstore://` 协议深链直达应用详情、安装确认与视图路由。
- **取舍备注**：
  - 早期规划的顶栏「GitHub API 速率配额胶囊（Rate Limit Pill）」已从界面退役，目前仅后端广播 `zstore://quota-updated` 并在设置页账号卡片展示配额说明。
  - Issue 04「Android Shizuku 静默安装」仅作跨平台技术预研归档，未合入桌面端生产链路。

#### #07 · `code-review-2026-09-20`
- **定位**：早期全项目双轴代码审查与契约门禁（报告归档），规范前后端 IPC 传参约定与历史缺陷清单。

---

### Phase 2: 趋势榜单重构、图标本地化与深度审计（2026-10-04 ~ 2026-10-21）

#### #08 · `feature-trends-board`
- **定位**：开源趋势榜单与 L2 缓存治理（6 / 6 Resolved）。
- **交付**：覆盖 6 类榜单（`daily`、`weekly`、`monthly`、`new`、`rising`、`healthy`），确立 DoForce 聚合源豁免、L2 落盘缓存与 SWR 异步富卡水合（[ADR-0011](../docs/adr/0011-doforce-trends-aggregator-exception.md)、[ADR-0014](../docs/adr/0014-trends-l2-and-governance.md)）。

#### #09 · `icon-fix`
- **定位**：本地图标缓存优先与打包图标退役（5 / 5 Resolved）。
- **交付**：移除包内捆绑的静态应用图标，建立本地缓存优先与按需探测机制。
- **演进备注**：早期 `{owner}_{repo}.png` 命名与部分探测回退逻辑后续由 `#15`、`#24` 演进为基于 URL 哈希的落盘缓存与 `app_icon_cycles` 周期管理（[ADR-0015](../docs/adr/0015-unified-icon-fetch-and-search-alignment.md)、[ADR-0025](../docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md)）。

#### #10 · `pending-apps`
- **定位**：待收录应用生命周期管理与草稿流（5 / 5 Resolved）。
- **交付**：本地自维护草稿、本地收录、已提交与已归档状态流（[ADR-0017](../docs/adr/0017-custom-apps-overlay.md)）。
- **取舍备注**：原规划的「批量 PR 提交（Batch PR Submit）」已裁撤并删除，收敛为单应用预填 Issue 提交至 `z-store-catalog`；该流程与 `#29` 开源广场（`z-store-launchpad`）平行共存、互不替代。

#### #11 · `architecture-deepening`
- **定位**：架构深度治理计划（14 / 14 Resolved）。
- **交付**：收敛图标获取、趋势聚合、AppShell、Catalog 接缝等核心深模块，并全面推行规范应用标识（[ADR-0010](../docs/adr/0010-canonical-app-identifier.md)）。

#### #12 · `code-review-2026-10-21`
- **定位**：深度安全与架构审计（48 / 48 Resolved），修复命令注入、路径穿越等高危问题并将 `.scratch/` 纳入 Git 版本跟踪。
- **取舍备注**：Issue 09 评估后**决定不引入 OS 级 DPAPI / Keyring**，维持令牌在本地 SQLite 的明文存储、接受风险并在导出备份时严格排除（[ADR-0020](../docs/adr/0020-token-plaintext-risk-acceptance.md)）。

---

### Phase 3: 性能加固、缓存优先与 UI 规范化（2026-11-08 ~ 2026-11-13）

#### #13 · `icon-l3-discovery-fix`
- **定位**：富卡与详情页 L1~L4 图标探测一致性（4 / 4 Resolved），对齐列表与详情页的图标探测和兜底行为。

#### #14 · `perf-and-cache-hardening`
- **定位**：全链路性能治理与 HTTP/目录缓存加固（5 / 5 Resolved），引入共享 HTTP 连接池（[ADR-0012](../docs/adr/0012-network-perf-p0-pooling-concurrency-skip.md)）与 ETag 条件请求（[ADR-0007](../docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)）。

#### #15 · `icon-and-cache-local-first`
- **定位**：图标与富卡本地缓存优先及写透治理（6 / 6 Resolved），确立「非资产面自动拉取 + 资产面手动触发」边界（[ADR-0019](../docs/adr/0019-asset-manual-cache-and-non-asset-auto-fetch.md)）。

#### #16 · `catalog-db-refactor`
- **定位**：Catalog 清单与 SQLite 分层规范（已落地），将内置 `catalog.json` 定位为冷启动种子与离线兜底，确立目录与详情表分离及增量同步。

#### #17 · `module-deepening`
- **定位**：全仓模块合并加深与碎片清理（9 / 9 Resolved），收敛浅层胶水模块与 `App.tsx` 状态 Hook。

#### #18 · `manage-ui-redesign`
- **定位**：管理中心（我的应用）UI 重设计（5 / 5 Resolved），将已安装与可用更新合并为统一工作台（[ADR-0022](../docs/adr/0022-my-apps-merges-installed-and-updates.md)）。
- **后续调整**：后续精简移除了独立的「已隐藏」筛选签，隐藏规则统一在规则管理弹窗中维护。

#### #19 · `button-size-and-inverted-icon-parity`
- **定位**：同级按钮盒尺寸统一与反色图标光学对齐（6 / 6 Resolved）。

---

### Phase 4: 本地隐私推荐与发现页重设计（2026-11-13 ~ 2026-11-14）

#### #20 · `feature-local-affinity-recommendation`
- **定位**：本地用户画像与动态推荐一期（6 / 6 Resolved），落地仓库特征信号持久化与本地隐私数据看板；**推荐排序与前端打分逻辑后续由 `#21`、`#23` 取代**。

#### #21 · `feature-featured-page-redesign`
- **定位**：精选页重设计（10 / 10 Resolved），用后端组装的可解释推荐货架取代静态排行榜，支持负反馈并拆出独立搜索结果页（[ADR-0023](../docs/adr/0023-featured-page-explainable-local-recommendation.md)）。

#### #22 · `feature-detail-homepage`
- **定位**：应用详情官方主页标签展示与单色视觉统一（3 / 3 Resolved）。

#### #23 · `affinity-algorithm-v2`
- **定位**：本地推荐算法二期（8 / 8 Resolved），采用本地与 GitHub 双源独立归一化、中英词袋 IDF 与日期种子货架轮换（[ADR-0024](../docs/adr/0024-affinity-scoring-v2-and-shelf-sampling.md)）。

---

### Phase 5: 网络管道收敛、索引解耦与计数对齐（2026-11-14 ~ 2026-11-16）

#### #24 · `outbound-proxy-and-asset-convergence`
- **定位**：系统代理动态感知与远端资产缓存收敛（6 / 6 Resolved），支持运行期热切换系统代理，并将图标、插图与头像统一收口至后端缓存（[ADR-0025](../docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md)）。

#### #25 · `richcard-cache-and-pipeline-convergence`
- **定位**：搜索、Star 与趋势富卡缓存收敛（6 / 6 Resolved，[ADR-0026](../docs/adr/0026-search-starred-cache-and-enrich-convergence.md)）；**其中列表与富卡的存储结构由 `#26` 进一步拆分**。

#### #26 · `unified-repo-card-and-index-caches`
- **定位**：独立单仓富卡表与列表瘦索引水合（6 / 6 Resolved），将有序 id 列表索引与 `repo_card_cache` 实体物理分离（[ADR-0027](../docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md)）。

#### #27 · `view-counts-and-filter-consistency`
- **定位**：多视图数量显示与筛选口径全局对齐（6 / 6 Resolved），落地 `<CountBadge>` 规范（[`docs/count-display.md`](../docs/count-display.md)）与全局平台筛选一致计数。

---

### Phase 6: 智能匹配引擎与开源广场 Launchpad（2026-11-16 ~ 2026-11-17）

#### #28 · `local-app-matcher-v2`
- **定位**：存量应用匹配引擎 v2（5 / 5 Resolved），以内存倒排索引、边界打分与变体词守卫取代早期启发式子串匹配（[ADR-0028](../docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md)）。

#### #29 · `feature-launchpad`
- **定位**：开源广场（Launchpad）新品发现与社交互动（8 / 8 Resolved），以独立数据仓 `z-store-launchpad` 与精选目录物理隔离，支持置顶推荐（商业赞助由维护者人工审核）与 GitHub Discussions 评论/顶帖（[ADR-0029](../docs/adr/0029-launchpad-social-discovery-and-isolated-manifest.md)）。

---

### Phase 7: 弹窗底座统一、后端优化与链路收敛（2026-11-17 ~ 2026-11-20）

#### #30 · `unified-modal-shell`
- **定位**：全站统一弹窗底座 `ModalShell` 与四级层级规范（2 / 2 Resolved）。

#### #31 · `backend-security-leaks-and-correctness`
- **定位**：后端专题一：安装器防注入与解压防爆限额、临时文件/挂载句柄 RAII 清理与规则错误传播（3 / 3 Resolved）。

#### #32 · `backend-asset-icon-io-and-http-resilience`
- **定位**：后端专题二：资产缓存复用主 DB、图标写入单飞与重试策略收敛（3 / 3 Resolved）。

#### #33 · `backend-catalog-index-and-affinity-cache`
- **定位**：后端专题三：`CatalogService` 哈希索引与画像 IDF 预计算（3 / 3 Resolved）。

#### #34 · `backend-sqlite-batching-and-async-offload`
- **定位**：后端专题四：SQLite 批量读写、`prepare_cached` 复用与阻塞 IO 异步卸载（3 / 3 Resolved）。

#### #35 · `backend-contract-consistency-and-hygiene`
- **定位**：后端专题五：元数据校验、端点 SSOT 与构建卫生收敛（2 / 2 Resolved）。

#### #36 · `richcard-pipeline-optimization`
- **定位**：在线搜索 / 趋势榜 / Star 富卡链路收敛与缓存治理（5 / 5 Resolved），抑制在线搜索补图风暴、统一请求复用与单订阅世代门控。

---

### Phase 8: 合集分享与开源广场自检工具

#### #37 · `feature-launchpad-preflight-and-badges`
- **定位**：开源广场应用内投稿预检向导与 README 徽章生成器（4 / 4 Resolved），提供仓库坐标、OSI 协议、Release 产物与图标探测的本地预检与 `<LaunchpadCard>` 实时预览，并支持一键生成深链与单色 README 徽章。

#### #38 · `feature-shareable-collections`
- **定位**：可分享应用合集深链与批量预览安装（4 / 4 Resolved），打通 `zstore://collection?...` 协议解析、合集预览与显式批量安装，以及「我的应用 / 收藏」清单深链与 Markdown 导出。

#### #39 · `feature-similar-and-alternatives`
- **定位**：商业软件「开源平替」搜索增强与详情页「相似开源项目」推荐（4 / 4 Resolved），引入 `alternatives` 元数据映射与检索评分增强，并复用 `CatalogIdf` 与 `seed_similarity_with_idf` 实现详情页零网络相似应用推荐（[ADR-0030](../docs/adr/0030-similar-apps-and-alternatives-search.md)）。

#### #40 · `module-deepening-v2`
- **定位**：全栈深模块收敛与命令层去编排化二期（9 / 9 Resolved），把领域编排从 `commands/*` 下沉到深模块：`CatalogService` 独占精选目录与本地库事务、`installer/managed.rs` 与 `oauth::revoke_oauth_session` 分别收口已纳管应用生命周期与会话清理、`repositories/detail_service.rs` 统一 `AppDetail` / 轻量 Release 跨 `ForgeProvider` 决议与多源 `Checksum Manifest`、`repositories/card_hydrator.rs` 收敛富卡水合与写透、`icons/lanes.rs` 持有四路 `IconFetch` 世代通道、`launchpad/` 与 `forge/http.rs` 共享无令牌清单传输；前端由 `repoEnrichCache.ts` 统一富卡池与详情治愈扇出、`iconStore` 统一 L5 轮换准入、`selectors.ts` 纯化并拆出 `usePlatformFilter` / `useMyAppsState` / `useStarredFeed` / `useTrendSession`，`DemoStore` 对齐 `Local Library` / `Launchpad` 详情与隐藏规则。

---

## 架构演进与取舍清单 (Superseded, Pruned & Trade-offs)

在迭代过程中，部分早期规划、算法或特性做了明确取舍、替换或裁撤，在此集中备注：

### 1. 已被后续架构取代的实现
- **`#03 feature-app-import` → `#28 local-app-matcher-v2`**：早期粗粒度子串启发式匹配已退役，替换为内存倒排索引、路径/词边界打分与变体词守卫（[ADR-0028](../docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md)）。
- **`#09 icon-fix` → `#15` / `#24`**：早期 `{owner}_{repo}.png` 命名与回退逻辑演进为基于 URL 哈希的磁盘缓存、`app_icon_cycles` 与动态系统代理资产收敛（[ADR-0015](../docs/adr/0015-unified-icon-fetch-and-search-alignment.md)、[ADR-0025](../docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md)）。
- **`#20 feature-local-affinity-recommendation` → `#21` + `#23`**：早期单源推荐与静态榜单被双源融合画像（[ADR-0024](../docs/adr/0024-affinity-scoring-v2-and-shelf-sampling.md)）和可解释精选货架（[ADR-0023](../docs/adr/0023-featured-page-explainable-local-recommendation.md)）取代，并移除前端重复打分器。
- **`#25 richcard-cache-and-pipeline-convergence` → `#26` + `#36`**：列表快照与富卡数据从早期复合信封拆分为「瘦 ID 列表索引」+ 独立 `repo_card_cache`（[ADR-0027](../docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md)）。

### 2. 明确裁撤、退役或不做的功能取舍
- **令牌加密存储（`#12` Issue 09 → [ADR-0020](../docs/adr/0020-token-plaintext-risk-acceptance.md)）**：放弃引入 OS 级 DPAPI / Keyring，接受本地 SQLite 明文存储并在导出备份时排除令牌。
- **安装包数字签名校验（`#04` → [ADR-0004](../docs/adr/0004-streaming-installer-and-checksum-verification.md)）**：放弃 Windows WinTrust Authenticode 校验，统一由流式 SHA-256 与官方 `Checksum Manifest` 保证完整性。
- **顶栏速率配额胶囊（`#06` → [`CONTEXT.md`](../CONTEXT.md)）**：顶栏 Rate Limit Pill 已退役，仅保留后台限流头解析广播与设置页账号卡说明文案。
- **待收录「批量 PR 提交」（`#10`）**：已裁撤并删除，保留单应用预填 Issue 提交至 `z-store-catalog`（与 `#29` 开源广场平行共存）。
- **「我的应用」已隐藏筛选签（`#18` 后续精简）**：移除独立「已隐藏」筛选签，隐藏规则统一在规则管理弹窗中管理。
- **Android Shizuku 静默安装（`#06` Issue 04）**：仅作技术预研归档，未合入桌面端生产链路。

### 3. 工程治理与审查归档（非业务特性）
- **`#07 code-review-2026-09-20`** 与 **`#12 code-review-2026-10-21`**：分别记录早期代码审查清单与 10-21 安全/工程治理工单。

---

> 协作规则、命令禁忌、UI 数量规范与 IPC 命名约定统一以 [`AGENTS.md`](../AGENTS.md) 为准，此处不再重复抄录。
