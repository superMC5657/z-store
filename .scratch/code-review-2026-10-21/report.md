# ZStore 全项目代码审查报告（2026-10-21）

- 范围：全树现状（基准点 = 空树，`git diff 4b825dc… HEAD`，415 文件 / 367 提交）
- 方法：两轮。第一轮按 code-review 双轴（Standards / Spec）；第二轮 4 个并行分片补覆盖（Rust 安全健壮性 / Rust 架构与命令面 / 前端核心 / 前端 services 与测试盲区）。两条 P1 安全发现经人工读码复核确认。
- 规范源：`AGENTS.md`（IPC 命名、注释规则）、`CONTEXT.md`（词汇表 + D1–D10）。
- 规格源：`CONTEXT.md` 契约 + `docs/adr/` 18 篇（项目无单一 Issue 规格）。
- 结论总量：去重合并后 **38 张工单**（原始发现约 85 条，按修复单元归并；09/30 号已拍板 resolved，残余动作分别拆出 37/38 号）。P1×6、P2×15、P3×17。

## 工单索引

| # | 严重度 | 标题 | Status |
|---|--------|------|--------|
| 01 | P1 | install 回退分支 cmd.exe 元字符注入 | ready-for-agent |
| 02 | P1 | 卸载快捷方式路径穿越删除 | ready-for-agent |
| 03 | P1 | 卸载命令串经 cmd.exe 注入 | ready-for-agent |
| 04 | P1 | toggleFavorite 无 catch，unhandled rejection | ready-for-agent |
| 05 | P1 | PendingView 保存类回调无 catch，按钮永久卡提交态 | ready-for-agent |
| 06 | P1 | 无全局 ErrorBoundary，数据加载错误态缺失 | ready-for-agent |
| 07 | P2 | 无 checksums 文件照常安装 + 自定义镜像任意主机 | ready-for-agent |
| 08 | P2 | IPC token 暴露面：PAT/ OAuth token 明文回传 webview | ready-for-agent |
| 09 | P2 | 令牌明文存储加固（DPAPI/keyring） | resolved（拍板：维持明文，残余→37） |
| 10 | P2 | 安装器健壮性加固包（zip 炸弹 / NSIS 死循环 / macOS 嵌套等） | ready-for-agent |
| 11 | P2 | deeplink 字节切片非字符边界 panic | ready-for-agent |
| 12 | P2 | config.toml 候选路径与默认值漂移、静默回退 | ready-for-agent |
| 13 | P2 | scanner 扫描/导入同步命令冻结 UI | ready-for-agent |
| 14 | P2 | forge 路径 URL 编码缺失与宿主判定过宽 | ready-for-agent |
| 15 | P2 | 非 GitHub forge 限流口径不一致 + 伪造配额 + sleep 竞态 | ready-for-agent |
| 16 | P2 | icon 坐标归一化旁路放行未知 forge 前缀入库 | ready-for-agent |
| 17 | P2 | OAuth 设备码轮询卸载后泄漏 | ready-for-agent |
| 18 | P2 | useAppSettings 持久化：无 catch / 不回读 / TTL 挡位 0 被吞 | ready-for-agent |
| 19 | P2 | 趋势榜缓存读-合并-写竞态丢数据 | ready-for-agent |
| 20 | P2 | components 层约 200 处中文硬编码绕过 i18n | ready-for-agent |
| 21 | P3 | 在线搜索失败伪装空结果、license 兜底 "FLOSS" 失真 | ready-for-agent |
| 22 | P3 | db 无 user_version 迁移机制 + import 未包事务 | ready-for-agent |
| 23 | P3 | forge provider 9 处复制分发 + msix 特判双轨 | ready-for-agent |
| 24 | P3 | 唯一口径收口：收录态判定 / raw has / 重复命令与函数 | ready-for-agent |
| 25 | P3 | 前端巨型组件拆分（PendingView 2629 行 / App.tsx / ViewType 分散） | ready-for-agent |
| 26 | P3 | catalog 长函数重构（455 行详情 / 279 行图标 / 合并形状两份） | ready-for-agent |
| 27 | P3 | Data Clumps：6 元组与 (id,owner,repo) 裸传、models 字段重复 | ready-for-agent |
| 28 | P3 | 前端重复形状收口（渐变 10+ 处 / remote_url 真值提取 4 处） | ready-for-agent |
| 29 | P3 | 死代码与注释卫生（void had / 历史叙述注释） | ready-for-agent |
| 30 | P3 | 文档-代码漂移：license 双名单 / 第三 Client 未记录 / 术语双轨 | resolved（拍板：保留第三池+license toml 为运行时源，残余→38） |
| 31 | P3 | D2 前端出口卡点：noDirectInvoke 只扫 views，2 处旁路 | ready-for-agent |
| 32 | P3 | 类型卫生：as unknown/as any 收口 + tsconfig 加严 | ready-for-agent |
| 33 | P3 | iconStore 四容器无上限增长 | ready-for-agent |
| 34 | P2 | CMD 表对齐：4 条命令绕过 CMD 表 / 无 UI 接线 | ready-for-agent |
| 35 | P3 | 草稿 forge 门禁与 enrich 键归一化分叉 | ready-for-agent |
| 36 | P3 | 测试与工具链盲区（7 hooks 零测试 / coverage / 种子校验） | ready-for-agent |
| 37 | P3 | 令牌风险 ADR 记录 + 备份导出排除令牌（09 拍板残余） | ready-for-agent |
| 38 | P3 | 文档-代码漂移整改（license SSOT / 第三池补记 / 术语澄清）（30 拍板残余） | ready-for-agent |

## 已验证无恙（校准基线，勿重复报告）

- ZIP/tar 解压无 zip-slip（`enclosed_name` + 剥顶层前判定 `..`/绝对路径并跳过链接条目，executor_portable.rs:65-130）。
- SHA-256 三路径统一 `.tmp` 落盘 + 终态哈希、不符即删，无"先落盘后校验"窗口、无虚假"已校验"（downloader_progress.rs:172-182）。
- 深链 install 仅暂存、须用户确认（useDeepLink.ts:24-36）；view 前端白名单。
- OAuth 无 client_secret，device flow 状态机 Pending/Expired/Denied 完整，token/code 不落日志。
- 日志双链脱敏（sanitize_url 键名级 + z_log 落盘 redact），抽查无凭据打点。
- 下载 URL 仅来自目录数据、不读 Content-Disposition、重定向上限 10。
- 卸载目录清理有 `is_owned_portable_dir` 规范化 + 大小写双重校验。
- db 层裸 SQL 仅白名单表名 + 整数 LIMIT 插值，其余全参数绑定；未见跨 await 持锁。
- lib.rs 注册表 96 定义 = 96 注册，无重复/缺失；缺 `rename_all` 的 55 个命令参数均为单词（豁免成立）。
- scanner lnk/registry 解析边界完备；trends 白名单防 SSRF；图标探测三层熔断（2MB/2万节点/32KB Range）。
- 前端：无新增 invoke 旁路（除 31 号工单 2 处已知）；locales 580 键双侧对齐；主要 hook 均有 cancelled guard；useToasts 无泄漏；加载点有 loading/error/retry 三态。
- feed 打分前后端镜像逐项一致；demo 71 mock 零漂移、args 全 camel；CI 四件套齐（vitest + tsc + clippy -D warnings + cargo test，Win/Linux 矩阵）。
- 规格数字核对：D5–D10 全部写死数字与代码一致（双池参数、并发 4/6/3/5/5、重试 2 次 200→800ms、32KB/300B、10s/2MB、L1/L2 TTL、200/256KB/512KiB、批量 40、seed 7、搜缓存 30min/50、schema 18 表、TTL 挡位）。

## 修复顺序建议

> 可粘贴的分批执行提示词见 `execution-plan.md`（38 张工单 → 13 个批次，单分支串行，每批一段直接贴进新会话）。

1. 安全 P1：01 → 02 → 03（安装/卸载 shell 与路径面）。
2. 前端 P1：04 → 05 → 06。
3. 暴露面与门禁：07、08、16、34；37（ADR + 备份核验）可与 08 同批。
4. 其余 P2 按域清理；P3 与重构批次按迭代消化。

---

## 复核（第二轮，2026-10-21）

- 范围：`git diff 1ac41eb...HEAD`（首轮 38 张工单的 39 个提交，163 文件，+11984/−4289）
- 方法：双轴 8 条并行只读分片——规范面 5 条（Rust 网络/安装、Rust 核心+文档、views/app、components、services+测试），规格面 3 条（01–13 / 14–23 / 24–38）。分片结论逐条回读源码复核后才采用。
- 规范源：`AGENTS.md`、`CONTEXT.md`（词汇表 + D1–D10）、`docs/adr/*`、`docs/logging.md`、`docs/agents/*`；外加 smell 基线（Fowler ch.3，仓库标准优先、只作判断项）。
- 规格源：本轮 38 张工单原文；工单 `Comments` 只作为待验证主张，不作证据。
- 结论：**Standards 15 条硬违规 + 15 组判断项；Spec 16 张工单有缺口（20 条发现）**。全部收口为 39–48 十张复核工单，均已 resolved。

### 复核工单索引

| # | 严重度 | 标题 | 对应残项 | 提交 |
|---|--------|------|----------|------|
| 39 | P1 | 配额刷新命令仍回传明文 PAT | 08 | e046c80 |
| 40 | P1 | 开始菜单卸载快捷方式路径未消毒 | 02 | e046c80 |
| 41 | P2 | 趋势截断吞正文 / .lnk 删除吞错 / 解压回滚残留目录 | 10 | e046c80 |
| 42 | P2 | 429 口径与 URL 编码只修了一半 | 14 / 15 | e046c80 |
| 43 | P2 | 设置回滚竞态 + 镜像切换假成功 | 04 / 18 | caa8f09 |
| 44 | P2 | DB 事务/迁移链/配置路径健壮性 | 12 / 22 / 27 | e046c80 |
| 45 | P2 | normalizeId 深层语义漂移与图标 URL 误归一 | 35 | caa8f09 |
| 46 | P3 | 前端结构残留（兼容再导出/双 toast/布尔陷阱/重复面板） | 25 / 27 / 28 / 31 | caa8f09 |
| 47 | P3 | 质量门禁盲区 | 34 / 36 / 28 / 38 | 0e2cf0f / 57ef4f4 |
| 48 | P3 | 文档-代码二次漂移与注释卫生回潮 | 20 / 29 / 38 | 71582c0 / 57ef4f4 |

### 首轮宣称核对

- 通过：`vitest` 870/870、`cargo test` 368 passed / 3 ignored —— 与首轮宣称一致。
- 未通过两处：`cmdAlignment` 的「96/96」（实测两侧均 94）；「coverage 已接入 CI」（只有配置，CI 跑的是不带 coverage 的 `pnpm run test`）。
- 首轮 08 号只删了 `get_host_tokens`：`refresh_host_rate_limit` 仍回传 PAT（第二严重项）。

### 复核后状态

- 分支 `fix/code-review-followup`，5 个提交：`0e2cf0f`（门禁）、`caa8f09`（前端）、`e046c80`（Rust 安全/健壮性）、`71582c0`（文档）、`57ef4f4`（注释与嵌入配置段锁）；87 文件，+1732/−666。
- 验证：`vitest` 894/894（89 文件）、`cargo test` 378 passed / 3 ignored、`clippy --all-targets -D warnings` 绿、`tsc` + `vite build` 绿。

### 明确遗留（不在本轮范围或已记录取舍）

1. `Retry-After` 的 HTTP-date 形态未支持——仓库无日期解析依赖，未新增 crate，helper doc 已写明按缺省 5s 处理。
2. `refresh_host_rate_limit` 无 UI 消费方：保留命令面但已去令牌；整条删除须同时改 CMD 表与 `lib.rs` 注册（cmdAlignment 已强制集合相等）。
3. 20 号范围外：`App.tsx` 约 10 处、components 约 26 个文件仍为 CJK 硬编码（门禁现覆盖 5 个文件）。
4. 三家 forge 的请求脚手架仍六份同形（`HttpSpan` 之外未再收拢）；toast 形状在 pending 之外仍有重复声明。
