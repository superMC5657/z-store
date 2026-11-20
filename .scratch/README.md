# ZStore Feature Specs & Issue Tracker 目录索引

> 本目录为 ZStore 项目的本地需求工单与技术规格中枢（Local Markdown Issue-Tracker），遵循 [`docs/agents/issue-tracker.md`](../docs/agents/issue-tracker.md) 约定。  
> 记录了项目自 MVP 启动以来**全部 35 个特性与架构专题**的完整演化脉络。所有专题均按照实际**执行时序（Execution Order）**依次编号并归档。

---

## 目录规范约定

- **单个特性对应单一目录**：`.scratch/<feature-slug>/`
- **核心规格文档**：`.scratch/<feature-slug>/spec.md`（或 `SPEC.md` / `plan.md`）
- **原子工单拆解**：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`（从 `01` 递增编号）
- **工单状态流转**：工单头部通过 `Status:` 标注状态（`needs-triage` $\to$ `ready` $\to$ `claimed` $\to$ `resolved`），遵循 [`docs/agents/triage-labels.md`](../docs/agents/triage-labels.md)
- **文档口径原则**：以“当前代码真相”为唯一基准，陈述现状而非过程叙事，必要时引证对应 ADR（见 [`docs/adr/`](../docs/adr/)）

---

## 执行时序全景速查表 (Master Execution Timeline)

| 顺序标识 | 研发阶段 (Phase) | Spec 目录 (Slug) | 专题 / 特性中文名称 | 落地时间 | 核心 Commit | 关联决策 (ADR) | 工单状态 |
| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **#01** | Phase 1: MVP 体系 | [`feature-mvp`](./feature-mvp/spec.md) | MVP 跨平台开源应用商店主体脚手架 | 2026-09-04 | `b9a5b82` | ADR-0001 ~ 0005 | 6 / 6 Resolved |
| **#02** | Phase 1: MVP 体系 | [`feature-multi-forge`](./feature-multi-forge/spec.md) | Feature A: 多托管源生态拓展 | 2026-09-04 | `d8999bc` | ADR-0006 | 4 / 4 Resolved |
| **#03** | Phase 1: MVP 体系 | [`feature-app-import`](./feature-app-import/spec.md) | Feature B: 系统存量开源软件扫描与纳管 | 2026-09-04 | `008596c` | ADR-0009 | 3 / 3 Resolved |
| **#04** | Phase 1: MVP 体系 | [`feature-update-ctrl`](./feature-update-ctrl/spec.md) | Feature C: 细粒度版本更新控制与签名校验 | 2026-09-04 | `9caefc9` | ADR-0004 | 3 / 3 Resolved |
| **#05** | Phase 1: MVP 体系 | [`feature-dev-ecosystem`](./feature-dev-ecosystem/spec.md) | Feature D: 开发者画像与生态互动 | 2026-09-04 | `473a1c2` | ADR-0003 | 4 / 4 Resolved |
| **#06** | Phase 1: MVP 体系 | [`feature-deep-link`](./feature-deep-link/spec.md) | Feature E: 系统协议唤起与多端原生引擎 | 2026-09-04 | `8ff2772` | ADR-0001, 0004 | 4 / 4 Resolved |
| **#07** | Phase 1: MVP 体系 | [`code-review-2026-09-20`](./code-review-2026-09-20/code-review-report.md) | 全项目双轴代码审查与早期门禁治理 | 2026-09-20 | `de9762b` | ADR-0010 | 报告归档 |
| **#08** | Phase 2: 趋势与图标 | [`feature-trends-board`](./feature-trends-board/spec.md) | 开源趋势榜单体系重构与 L2 缓存治理 | 2026-10-04 | `1b0bbe8` | ADR-0011, 0014 | 6 / 6 Resolved |
| **#09** | Phase 2: 趋势与图标 | [`icon-fix`](./icon-fix/spec.md) | 本地图标缓存优先与打包图标退役 | 2026-10-10 | `a52a1d3` | ADR-0015 | 5 / 5 Resolved |
| **#10** | Phase 2: 趋势与图标 | [`pending-apps`](./pending-apps/SPEC.md) | 待收录应用生命周期管理与草稿流 | 2026-10-11 | `084156e` | ADR-0017 | 5 / 5 Resolved |
| **#11** | Phase 2: 趋势与图标 | [`architecture-deepening`](./architecture-deepening/plan.md) | 架构深度治理计划（C1~C6 核心卡片） | 2026-10-11 | `fd70c4b` | ADR-0006, 0010 | 14 / 14 Resolved |
| **#12** | Phase 2: 趋势与图标 | [`code-review-2026-10-21`](./code-review-2026-10-21/execution-plan.md) | 10-21 深度代码审计与工单体系入库 | 2026-10-21 | `68bb2ff` | ADR-0018, 0020 | 48 / 48 Resolved |
| **#13** | Phase 3: 性能与缓存 | [`icon-l3-discovery-fix`](./icon-l3-discovery-fix/spec.md) | 富卡与详情页 L3/L4 图标多级探索一致性 | 2026-11-08 | `7f8f8a6` | ADR-0010, 0015 | 4 / 4 Resolved |
| **#14** | Phase 3: 性能与缓存 | [`perf-and-cache-hardening`](./perf-and-cache-hardening/spec.md) | 全链路性能治理与 HTTP/目录缓存加固 | 2026-11-10 | `e482f20` | ADR-0007, 0012 | 5 / 5 Resolved |
| **#15** | Phase 3: 性能与缓存 | [`icon-and-cache-local-first`](./icon-and-cache-local-first/spec.md) | 图标与富卡全字段本地缓存优先与写透 | 2026-11-11 | `f80b164` | ADR-0003, 0019 | 6 / 6 Resolved |
| **#16** | Phase 3: 性能与缓存 | [`catalog-db-refactor`](./catalog-db-refactor/spec.md) | Catalog 清单与 SQLite 分层重构架构规范 | 2026-11-12 | `b76e1f7` | ADR-0017 | Schema v2 落地 |
| **#17** | Phase 3: 性能与缓存 | [`module-deepening`](./module-deepening/spec.md) | 全仓模块合并加深与浅层碎片文件清理 | 2026-11-12 | `675542e` | ADR-0004, 0018 | 8 / 9 Resolved |
| **#18** | Phase 3: 性能与缓存 | [`manage-ui-redesign`](./manage-ui-redesign/spec.md) | 管理中心（已安装 & 更新）UI 深度重设计 | 2026-11-12 | `92b3fe5` | UI 体验规范 | 5 / 5 Resolved |
| **#19** | Phase 3: 性能与缓存 | [`button-size-and-inverted-icon-parity`](./button-size-and-inverted-icon-parity/spec.md) | 全站同级按钮盒尺寸严格统一与反色图标 | 2026-11-13 | `d59aa1d` | UI 体验规范 | 6 / 6 Resolved |
| **#20** | Phase 4: 本地推荐 | [`feature-local-affinity-recommendation`](./feature-local-affinity-recommendation/spec.md) | 本地用户画像与 Catalog 动态推荐一期 | 2026-11-13 | `d5e9cd2` | ADR-0013 | 6 / 6 Resolved |
| **#21** | Phase 4: 本地推荐 | [`feature-featured-page-redesign`](./feature-featured-page-redesign/spec.md) | 精选页重设计（可解释的本地推荐货架） | 2026-11-14 | `94f9f68` | ADR-0023 | 10 / 10 Resolved |
| **#22** | Phase 4: 本地推荐 | [`feature-detail-homepage`](./feature-detail-homepage/spec.md) | 应用详情弹窗官方主页展示与单色视觉统一 | 2026-11-14 | `43515cd` | ADR-0001, 0010 | 3 / 3 Resolved |
| **#23** | Phase 4: 本地推荐 | [`affinity-algorithm-v2`](./affinity-algorithm-v2/spec.md) | 本地推荐算法二期优化（单调词袋与温度轮换） | 2026-11-14 | `1943942` | ADR-0023, 0024 | 8 / 8 Resolved |
| **#24** | Phase 5: 管道收敛 | [`outbound-proxy-and-asset-convergence`](./outbound-proxy-and-asset-convergence/spec.md) | 系统代理动态热感知与远端资产缓存收敛 | 2026-11-14 | `a4e7104` | ADR-0025 | 6 / 6 Resolved |
| **#25** | Phase 5: 管道收敛 | [`richcard-cache-and-pipeline-convergence`](./richcard-cache-and-pipeline-convergence/spec.md) | 搜索、Star 与趋势富卡缓存收敛及链路优化 | 2026-11-15 | `3967910` | ADR-0026 | 6 / 6 Resolved |
| **#26** | Phase 5: 管道收敛 | [`unified-repo-card-and-index-caches`](./unified-repo-card-and-index-caches/spec.md) | 单仓富卡独立缓存表与三链路瘦索引水合 | 2026-11-15 | `b035d5d` | ADR-0027 | 6 / 6 Resolved |
| **#27** | Phase 5: 管道收敛 | [`view-counts-and-filter-consistency`](./view-counts-and-filter-consistency/spec.md) | 多视图应用数量显示与筛选口径全局对齐 | 2026-11-15 | `efbae62` | ADR-0021, 0022 | 6 / 6 Resolved |
| **#28** | Phase 6: 匹配与广场 | [`local-app-matcher-v2`](./local-app-matcher-v2/spec.md) | 存量应用匹配引擎 v2（内存倒排索引与安全打分） | 2026-11-16 | `b18fb19` | ADR-0028 | 5 / 5 Resolved |
| **#29** | Phase 6: 匹配与广场 | [`feature-launchpad`](./feature-launchpad/spec.md) | 开源广场（Launchpad）社交导流与零后端上架 | 2026-11-16 | `537afed` | ADR-0029 | 8 / 8 Resolved |
| **#30** | Phase 7: 底座与优化 | [`unified-modal-shell`](./unified-modal-shell/spec.md) | 全站统一弹窗底座与语义层级规范 (ModalShell) | 2026-11-17 | `aef5439` | UI 底座规范 | 2 / 2 Resolved |
| **#31** | Phase 7: 底座与优化 | [`backend-security-leaks-and-correctness`](./backend-security-leaks-and-correctness/spec.md) | 后端专题一：安装器安全、异步泄漏与规则健壮性 | 2026-11-17 | `430e222` | ADR-0004, 0028 | 3 / 3 Resolved |
| **#32** | Phase 7: 底座与优化 | [`backend-asset-icon-io-and-http-resilience`](./backend-asset-icon-io-and-http-resilience/spec.md) | 后端专题二：资产与图标磁盘缓存治理与 HTTP 重试 | 2026-11-17 | `8e1fde2` | ADR-0012, 0025 | 3 / 3 Resolved |
| **#33** | Phase 7: 底座与优化 | [`backend-catalog-index-and-affinity-cache`](./backend-catalog-index-and-affinity-cache/spec.md) | 后端专题三：`CatalogService` 哈希索引与画像预计算 | 2026-11-18 | `867a5d4` | ADR-0010, 0024 | 3 / 3 Resolved |
| **#34** | Phase 7: 底座与优化 | [`backend-sqlite-batching-and-async-offload`](./backend-sqlite-batching-and-async-offload/spec.md) | 后端专题四：SQLite 批量读写去重与阻塞 IO 异步卸载 | 2026-11-18 | `67f053e` | ADR-0003, 0027 | 3 / 3 Resolved |
| **#35** | Phase 7: 底座与优化 | [`backend-contract-consistency-and-hygiene`](./backend-contract-consistency-and-hygiene/spec.md) | 后端专题五：后端元数据校验、端点 SSOT 与收尾卫生 | 2026-11-18 | `a5fb3b8` | ADR-0010, 0018 | 2 / 2 Resolved |

---

## 阶段演进与 Spec 深度解析

### Phase 1: MVP 雏形与基础生态架构构建（2026-09-04 ~ 2026-09-20）

本阶段奠定了 ZStore 作为跨平台（Windows / Linux / macOS）开源桌面应用商店的骨架，确立了客户端直连无中心化后端（Serverless Direct API）的核心理念。

#### #01 · `feature-mvp`
- **定位**：MVP 跨平台开源应用商店主体脚手架
- **核心交付**：
  - Tauri 2.0 + React 18 + TypeScript + Fluent 2 视觉底座（[ADR-0001](../docs/adr/0001-tauri2-and-react-fluent-architecture.md)）。
  - GitHub REST API 客户端直连与镜像自适应管道（[ADR-0002](../docs/adr/0002-direct-github-api-and-mirror-pipeline.md)）。
  - SQLite 本地轻量持久化与 ETag 缓存（[ADR-0003](../docs/adr/0003-sqlite-persistence-and-etag-caching.md)）。
  - 流式安装器、SHA-256 完整性校验与 MSI/EXE 安装调度（[ADR-0004](../docs/adr/0004-streaming-installer-and-checksum-verification.md)）。
- **工单规模**：6 张工单（全部 Resolved）。

#### #02 · `feature-multi-forge` (Feature A)
- **定位**：多托管源生态拓展
- **核心交付**：
  - 抽象 `ForgeProvider` 特征契约，接入 Codeberg、Gitea 及私有 GitLab 实例（[ADR-0006](../docs/adr/0006-multi-forge-ecosystem-support.md)）。
  - 建立通用仓库标识符（URI）解析机制，解除对单一 GitHub 源的硬编码绑定。
- **工单规模**：4 张工单（全部 Resolved）。

#### #03 · `feature-app-import` (Feature B)
- **定位**：系统存量开源软件扫描与纳管
- **核心交付**：
  - Windows 注册表（`Uninstall` 键）与 Start Menu 快捷方式遍历。
  - 基于软件名称与发布者的启发式指纹匹配，支持一键接管版本更新生命周期。
- **工单规模**：3 张工单（全部 Resolved）。

#### #04 · `feature-update-ctrl` (Feature C)
- **定位**：细粒度版本更新控制与签名校验
- **核心交付**：
  - 建立 `update_rules` 表，支持单应用配置“跳过此版本”与“锁定当前版本”。
  - Windows 端接入 WinTrust Authenticode 微软数字签名验证机制，提升防篡改能力。
- **工单规模**：3 张工单（全部 Resolved）。

#### #05 · `feature-dev-ecosystem` (Feature D)
- **定位**：开发者画像与生态互动
- **核心交付**：
  - 聚合展示开发者个人 Profile、组织矩阵与旗下全部开源仓库。
  - GitHub 账号 Star 清单双向同步与本地最近浏览足迹持久化。
- **工单规模**：4 张工单（全部 Resolved）。

#### #06 · `feature-deep-link` (Feature E)
- **定位**：系统协议唤起与多端原生引擎
- **核心交付**：
  - 注册系统级 `zstore://` 协议 Scheme，支持网页端外链直达应用详情并唤起安装。
  - 顶栏常驻 GitHub API 速率配额监控药丸胶囊（Rate Limit Pill）。
- **工单规模**：4 张工单（全部 Resolved）。

#### #07 · `code-review-2026-09-20`
- **定位**：全项目双轴代码审查与早期质量门禁
- **核心交付**：
  - 对早期 118 个 Commit 开展 Standards（规范）与 Spec（需求）双轴审计。
  - 规范前后端 IPC 传参约定，输出全量审查报告与整改清单。
- **工单规模**：报告归档（涵盖全仓历史漏洞与契约漂移治理）。

---

### Phase 2: 趋势榜单重构、图标去中心化与首轮深度审计（2026-10-04 ~ 2026-10-21）

本阶段重点提升发现页信息密度，解决图标与趋势榜的真实网络保鲜问题，并完成全仓首轮深度安全治理。

#### #08 · `feature-trends-board`
- **定位**：开源趋势榜单体系重构与 L2 缓存治理
- **核心交付**：
  - 重构 8 大开源趋势榜单，解决日榜与新秀榜单的数据抓取保鲜难题（[ADR-0014](../docs/adr/0014-trends-l2-and-governance.md)）。
  - 建立趋势 L2 缓存、SWR（Stale-While-Revalidate）更新机制与富卡异步水合管道。
  - 确立 DoForce 趋势聚合器特权豁免（[ADR-0011](../docs/adr/0011-doforce-trends-aggregator-exception.md)）。
- **工单规模**：6 张工单（全部 Resolved）。

#### #09 · `icon-fix`
- **定位**：本地图标缓存优先与打包图标退役
- **核心交付**：
  - 彻底移除安装包内捆绑的应用图标资产，客户端体积大幅缩减。
  - 确立 `{owner}_{repo}.png` 单一命名规范与保护机制（[ADR-0015](../docs/adr/0015-unified-icon-fetch-and-search-alignment.md)）。
  - 构建严格本地缓存优先、自适应镜像下载与 404 短路回退引擎。
- **工单规模**：5 张工单（全部 Resolved）。

#### #10 · `pending-apps`
- **定位**：待收录应用生命周期管理与草稿流
- **核心交付**：
  - 建立客户端本地自维护待收录应用体系（[ADR-0017](../docs/adr/0017-custom-apps-overlay.md)）。
  - 涵盖草稿录入、待提交、已提交与已归档完整状态流，打通与侧栏数量徽标联动。
- **工单规模**：5 张工单。

#### #11 · `architecture-deepening`
- **定位**：架构深度治理计划（C1~C6 核心卡片）
- **核心交付**：
  - 落实 C1 图标获取、C2 趋势聚合、C3 AppShell 治理、C4 Catalog 接缝、C6 详情弹窗扁平化等 6 大深层模块。
  - 全面推行规范应用标识符（[ADR-0010 Canonical App Identifier](../docs/adr/0010-canonical-app-identifier.md)），退役所有旧格式兼容层。
- **工单规模**：14 项工单全量落地。

#### #12 · `code-review-2026-10-21`
- **定位**：10-21 深度代码审计与工单体系入库
- **核心交付**：
  - 开展全仓大规模排查，修复命令注入、路径穿越、DPAPI 凭据安全存储等高危风险。
  - 移除 `.gitignore` 对 `.scratch/` 的忽略，建立基于 Git 的本地 Issue-Tracker 版本跟踪机制。
- **工单规模**：48 张工单全量 Resolved。

---

### Phase 3: 全链路性能加固、缓存优先与模块加深（2026-11-08 ~ 2026-11-13）

聚焦于首屏性能、数据分层解耦与代码结构深化。

#### #13 · `icon-l3-discovery-fix`
- **定位**：富卡与详情页 L3/L4 图标多级探索一致性
- **核心交付**：解决富卡列表与详情弹窗在 L1~L4 多级图标探测中的状态漂移问题，统一 404 短路缓存与生成头像兜底逻辑。
- **工单规模**：4 张工单（全部 Resolved）。

#### #14 · `perf-and-cache-hardening`
- **定位**：全链路性能治理与 HTTP/目录缓存加固
- **核心交付**：
  - `CatalogService` 建立 $O(1)$ 索引；实现 Release 与目录的 HTTP 304 ETag 条件拉取。
  - 统一 HTTP 连接池避免端口泄漏（[ADR-0012](../docs/adr/0012-network-perf-p0-pooling-concurrency-skip.md)）；精简前端响应式扇出，杜绝无效重渲。
- **工单规模**：5 张工单（全部 Resolved）。

#### #15 · `icon-and-cache-local-first`
- **定位**：图标与富卡全字段本地缓存优先及写透治理
- **核心交付**：重构缓存分层，富卡详情更新时全链路穿透写入 SQLite（Write-Through），保障完全离线可用性（[ADR-0019](../docs/adr/0019-asset-manual-cache-and-non-asset-auto-fetch.md)）。
- **工单规模**：6 张工单（全部 Resolved）。

#### #16 · `catalog-db-refactor`
- **定位**：Catalog 清单与 SQLite 分层重构架构规范
- **核心交付**：将只读 `catalog.json` 降级为冷启动种子，迁移 SQLite `user_version = 2`，建立 `catalog_apps` 与 `app_details` 三表分离与增量同步引擎。
- **工单规模**：核心架构迁移规范。

#### #17 · `module-deepening`
- **定位**：全仓模块合并加深与浅层碎片文件清理
- **核心交付**：深度实践 Deep Modules 理念，清除仅做薄透传的中间胶水文件，合并前后端命令与服务层，提高内聚度。
- **工单规模**：9 张工单（8 项已 Resolved）。

#### #18 · `manage-ui-redesign`
- **定位**：管理中心（已安装 & 更新）UI 深度重设计
- **核心交付**：重塑管理中心已安装与更新页面，统一图标安全区三档 `AppIconFrame`，重构规则管理弹窗。
- **工单规模**：5 张工单。

#### #19 · `button-size-and-inverted-icon-parity`
- **定位**：全站同级按钮盒尺寸严格统一与反色图标光学对齐
- **核心交付**：对齐全站 9 大主视图操作按钮高度（32px/28px/24px），优化深浅色反色矢量图标的光学居中与无障碍焦点体验。
- **工单规模**：6 张工单（全部 Resolved）。

---

### Phase 4: 本地隐私推荐系统与发现页货架重构（2026-11-13 ~ 2026-11-14）

在零服务端参与的前提下，依托客户端算力实现可解释的个性化开源软件推荐体系。

#### #20 · `feature-local-affinity-recommendation`
- **定位**：本地用户画像与 Catalog 动态推荐一期
- **核心交付**：
  - 基于 GitHub Star/Fork 与本地已装应用构建用户技术栈画像。
  - 在 SQLite 本地实现 TF-IDF 与余弦相似度推荐打分（[ADR-0013](../docs/adr/0013-feed-contract.md)）。
  - 提供透明可见的本地推荐隐私数据看板。
- **工单规模**：6 张工单（全部 Resolved）。

#### #21 · `feature-featured-page-redesign`
- **定位**：精选页重设计（可解释的本地推荐货架）
- **核心交付**：
  - 传统静态榜单升级为多维模块化货架（猜你喜欢、最近浏览、技术栈精选）（[ADR-0023](../docs/adr/0023-featured-page-explainable-local-recommendation.md)）。
  - 每项推荐提供明确可解释理由；支持“减少此类推荐”负反馈机制；独立拆分搜索结果页。
- **工单规模**：10 张工单（全部 Resolved）。

#### #22 · `feature-detail-homepage`
- **定位**：应用详情弹窗官方主页展示与单色视觉统一
- **核心交付**：详情页顶部引入“地球图标 + 域名”标签外链入口，各平台安装包标签与富卡单色纯图标视觉对齐。
- **工单规模**：3 张工单（全部 Resolved）。

#### #23 · `affinity-algorithm-v2`
- **定位**：本地推荐算法二期优化（单调词袋与温度轮换）
- **核心交付**：
  - 本地应用与 GitHub 信号双源独立归一化，解决样本倾斜与冷启动偏见（[ADR-0024](../docs/adr/0024-affinity-scoring-v2-and-shelf-sampling.md)）。
  - 引入中英混合分词与词界词袋提取；实现带温度系数的货架随机轮换算法。
- **工单规模**：8 张工单（全部 Resolved）。

---

### Phase 5: 网络管道收敛、数据索引解耦与视图口径对齐（2026-11-14 ~ 2026-11-16）

治理网络底层弹性，重构卡片缓存结构，消除跨视图统计口径不一致。

#### #24 · `outbound-proxy-and-asset-convergence`
- **定位**：系统代理动态热感知与远端资产缓存收敛
- **核心交付**：
  - 客户端热监听操作系统代理变更并无缝重载连接池（[ADR-0025](../docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md)）。
  - 消除直连泄露漏洞；统一 README 资产图片与远端头像的本地缓存隔离策略。
- **工单规模**：6 张工单（全部 Resolved）。

#### #25 · `richcard-cache-and-pipeline-convergence`
- **定位**：搜索、Star 与趋势富卡缓存收敛及链路优化
- **核心交付**：收敛多源业务卡片数据结构，消除重复的数据模型与冗余抓取，统一 L2 缓存 Hydration 与 SWR 更新机制（[ADR-0026](../docs/adr/0026-search-starred-cache-and-enrich-convergence.md)）。
- **工单规模**：6 张工单（全部 Resolved）。

#### #26 · `unified-repo-card-and-index-caches`
- **定位**：单仓富卡独立缓存表与三链路瘦索引水合
- **核心交付**：将“列表瘦 ID 索引（Slim IDs）”与“富卡实体（RepoCard）”彻底物理剥离，富卡独立存储于 `repo_card_cache` 表，大幅降低 SQLite 冗余读写（[ADR-0027](../docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md)）。
- **工单规模**：6 张工单（全部 Resolved）。

#### #27 · `view-counts-and-filter-consistency`
- **定位**：多视图应用数量显示与筛选口径全局对齐
- **核心交付**：
  - 制定并全站推行 `<CountBadge>` 规范（见 [`docs/count-display.md`](../docs/count-display.md)）。
  - 彻底对齐侧栏平台筛选与各视图（最新入库、分类、我的应用、待收录等）可见内容计数，杜绝切换闪烁。
- **工单规模**：6 张工单（全部 Resolved）。

---

### Phase 6: 智能匹配引擎升级与开源广场 Launchpad（2026-11-16 ~ 2026-11-17）

推出存量应用高精度匹配算法，并上线面向独立开发者的开源广场（Launchpad）。

#### #28 · `local-app-matcher-v2`
- **定位**：存量应用匹配引擎 v2（内存倒排索引与安全打分）
- **核心交付**：
  - 基于内存倒排索引与词/路径边界比较，重构系统存量软件识别引擎（[ADR-0028](../docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md)）。
  - 引入衍生版本变体词守卫机制，有效防止误匹配，支持全局一对一指派。
- **工单规模**：5 张工单（全部 Resolved）。

#### #29 · `feature-launchpad`
- **定位**：开源广场（Launchpad）社交导流与零后端上架
- **核心交付**：
  - 上线独立一级视图 Launchpad，采用独立数据仓 `z-store-launchpad` 物理隔离主清单（[ADR-0029](../docs/adr/0029-launchpad-social-discovery-and-isolated-manifest.md)）。
  - 接入 GitHub Discussions 混合读取、应用内评论与 `+1` 顶帖。
  - 建立基于 GitHub Issue 的全自动化免审核/免后端提交上架流。
- **工单规模**：8 张工单（全部 Resolved）。

---

### Phase 7: 全站弹窗底座统一与后端 Rust 深度性能治理（2026-11-17 ~ 2026-11-18）

统一前端 UI 模态底座，并对后端 Rust 进行全域安全加固、阻塞 IO 异步卸载与数据库批处理优化。

#### #30 · `unified-modal-shell`
- **定位**：全站统一弹窗底座与语义层级规范 (ModalShell)
- **核心交付**：
  - 抽象并落地统一的 `ModalShell` 核心底座组件。
  - 划分四级语义层级 Token（`root-flow`、`sub-flow`、`inspect-detail`、`system-interrupt`），统一 Esc 关闭与键盘焦点捕获（A11y）。
- **工单规模**：2 张工单（全部 Resolved）。

#### #31 · `backend-security-leaks-and-correctness`
- **定位**：后端优化专题一：安装器安全、异步泄漏与规则健壮性
- **核心交付**：
  - PowerShell 传参加固防注入；ZIP/Tar 解压硬限防止解压炸弹攻击。
  - 下载临时文件与 Windows/macOS 挂载句柄引入 RAII Drop 机制，杜绝异步取消导致的资源泄漏。
  - 强化规则读取异常向上传播，杜绝静默清空。
- **工单规模**：3 张工单（全部 Resolved）。

#### #32 · `backend-asset-icon-io-and-http-resilience`
- **定位**：后端优化专题二：资产与图标磁盘缓存治理与 HTTP 重试
- **核心交付**：
  - 修复 Release Checksum 头传递 Bug；`asset_fetch` 复用主 `AppState.db` 消除重复数据库句柄。
  - 图标磁盘 LRU 清理节流与下载 Single-Flight 单飞并发去重；统一全域 D7 指数退避重试契约。
- **工单规模**：3 张工单（全部 Resolved）。

#### #33 · `backend-catalog-index-and-affinity-cache`
- **定位**：后端优化专题三：`CatalogService` 哈希索引与画像预计算
- **核心交付**：
  - `CatalogService` 内部从线性扫描重构为 HashMap $O(1)$ 点查。
  - 支持锁内轻量字段投影，消除全量 `CatalogItem` 克隆。
  - 全局预计算并缓存 `CatalogIdf`，大幅缩减推荐画像计算耗时。
- **工单规模**：3 张工单（全部 Resolved）。

#### #34 · `backend-sqlite-batching-and-async-offload`
- **定位**：后端优化专题四：SQLite 批量读写去重与阻塞 IO 异步卸载
- **核心交付**：
  - 消除 N+1 查询：引入批量 `IN (...)` 读取与批量 `upsert`。
  - 全面应用 `prepare_cached` 缓存预编译 SQL 语句；合并命令层数据库锁。
  - 将繁重文件读写、哈希校验、解压缩及注册表扫描全面卸载到 `tokio::task::spawn_blocking`。
- **工单规模**：3 张工单（全部 Resolved）。

#### #35 · `backend-contract-consistency-and-hygiene`
- **定位**：后端优化专题五：后端元数据校验、端点 SSOT 与收尾卫生
- **核心交付**：
  - 收口跨模块重复代码：GitHub 端点编码、License 格式化、分类字典与占位符统一收归单一真实源（SSOT）。
  - 统一命令层错误处理为 `AppResult<T>` 闭环；消除全平台 Clippy 警告与死分支代码。
- **工单规模**：2 张工单（全部 Resolved）。

---

## 架构演化：被废弃、取代与裁剪的特性清单 (Deprecated & Superseded)

在 ZStore 快速迭代演进中，部分早期 Spec、算法或子功能已被后续更优方案**彻底取代、重构或废弃**。梳理如下：

### 1. 彻底被后置架构取代的 Spec (Superseded)
- **`feature-app-import` (#03) $\xrightarrow{\text{取代}}$ `local-app-matcher-v2` (#28)**：
  - *废弃内容*：基于注册表粗粒度子串匹配与模糊启发式（Heuristic Matching）。
  - *现行方案*：ADR-0028 引入内存倒排索引（Inverted Index）、词/路径边界防误报守卫与衍生版本变体词拦截，旧算法彻底退役。
- **`icon-fix` (#09) $\xrightarrow{\text{取代}}$ `icon-and-cache-local-first` (#15) / `outbound-proxy` (#24)**：
  - *废弃内容*：早期的阶段性图标修复草案及部分复杂探测回退逻辑。
  - *现行方案*：被全字段本地缓存优先（ADR-0019）与系统代理动态热感知资产隔离（ADR-0025）全面取代。
- **`feature-local-affinity-recommendation` (#20) $\xrightarrow{\text{取代}}$ `affinity-algorithm-v2` (#23)**：
  - *废弃内容*：一期简单的单源 GitHub Star/Fork 统计与静态高星推荐。
  - *现行方案*：被 ADR-0024 的“本地应用 + GitHub 用户画像”双源独立归一化、中英分词单调词袋与温度轮换货架取代；精选页静态排行榜亦被 ADR-0023 货架取代。
- **`richcard-cache-and-pipeline-convergence` (#25) $\xrightarrow{\text{取代}}$ `unified-repo-card-and-index-caches` (#26)**：
  - *废弃内容*：尝试将列表状态与富卡大对象保存在同一复合缓存信封的设计。
  - *现行方案*：ADR-0027 彻底拆分“瘦 ID 列表索引（Slim IDs）”与独立的 `repo_card_cache` 实体表，避免了重负荷 IO。

### 2. 明确被裁剪 / 移除的子功能 (Pruned / Removed)
- **`pending-apps` (#10) 的「批量 PR 提交（Batch PR Submit）」**：
  - 原规划的待收录批量向官方仓库提交 PR 功能在 commit `d67848f` 中被**正式废弃并全量删除**，收敛为单应用 Issue 模板提交，后续进一步被 `#29 feature-launchpad` 自动化上架流接管。
- **`feature-deep-link` (#06) 中的 Android Shizuku 静默安装（Issue 04）**：
  - 该工单属于跨平台移动端“技术预研（Research）”，相关方案作为设计储备，未在当前桌面端（Windows / Linux / macOS）合入生产链路。
- **`module-deepening` (#17) 中的 Issue 09 (`App.tsx` 多列表状态合并)**：
  - 属于第四阶段重构设想，工单状态保持 `needs-triage`，前三阶段核心模块加深（Issues 01~08）完成后未在本轮铺开。

### 3. 专项审查报告类文档（非业务功能 Spec）
- **`code-review-2026-09-20` (#07)** 与 **`code-review-2026-10-21` (#12)**：
  - 记录全仓双轴审查与安全排查（如 Win32 命令注入、路径穿越、DPAPI 加密存储等），属于工程治理与质量门禁归档，非新增业务特性。

---

## 协作规范与命令速查 (Contributor & Agent Guidelines)

在此目录进行日常维护或新增特性时，必须遵守以下核心准则：

1. **环境与命令禁忌**：
   - Windows 环境下**严禁使用 `find`**，应使用 `fd`。
   - 使用 `rg` 时**必须显式传递路径**（例如：`rg -n "pattern" .`）。
2. **UI 数量规范**：
   - 界面中附加于标签的任何数量展示均必须遵循 [`docs/count-display.md`](../docs/count-display.md) 使用 `<CountBadge>`，严禁硬编码括号文本或独立数量样式。
3. **IPC 命名规范**：
   - 前端调用参数**必须使用 camelCase**（例如：`appId`, `forceRefresh`, `perPage`）。
   - Rust 后端结构体使用 snake_case，并通过 `#[tauri::command(rename_all = "camelCase")]` 自动桥接。
4. **工作流覆盖准则**：
   - 使用 `/implement` 执行工单时，在所有测试通过且变更提交后立即停止，不得在同一会话内直接启动代码审查。
