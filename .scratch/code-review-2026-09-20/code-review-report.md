# Z-Store 全项目双轴代码审查报告 (Code Review Report)

- **审查基准**: `8f833f6...HEAD` (全量项目，共 118 个 Commits)
- **审查范围**: 全量源码 (`src/`, `src-tauri/`) 与规范文档 (`CONTEXT.md`, `docs/adr/`, `.scratch/*/spec.md`, `docs/design/`)
- **审查方式**: 双轴并行审查 (Standards Axis + Spec Axis)

---

## 目录
1. [审查背景与方法论](#1-审查背景与方法论)
2. [Standards (规范与代码异味轴)](#2-standards-规范与代码异味轴)
   - [2.1 文档规范硬违规 (Documented Standards Violations)](#21-文档规范硬违规-documented-standards-violations)
   - [2.2 基础代码异味判定 (Baseline Fowler Code Smells)](#22-基础代码异味判定-baseline-fowler-code-smells)
3. [Spec (功能契约与规格实现轴)](#3-spec-功能契约与规格实现轴)
   - [3.1 缺失或不完整的需求 (Missing or Partial Requirements)](#31-缺失或不完整的需求-missing-or-partial-requirements)
   - [3.2 范围蔓延与未定义行为 (Scope Creep)](#32-范围蔓延与未定义行为-scope-creep)
   - [3.3 实现偏离与错误行为 (Implemented but Incorrect)](#33-实现偏离与错误行为-implemented-but-incorrect)
4. [双轴综合结论与改进建议](#4-双轴综合结论与改进建议)

---

## 1. 审查背景与方法论

本报告基于 Matt Pocock 的双轴审查方法论（Two-Axis Code Review）：
- **Standards 轴**：审查代码实现是否严格遵循项目既定 ADR 架构决策、统一领域词汇表（`CONTEXT.md`）、日志与代码规范，并对照 Martin Fowler《重构》经典代码异味（Code Smells）基线。
- **Spec 轴**：审查系统功能实现是否忠实、完整地落实了需求规格说明书（`docs/design/应用需求报告.md`、`.scratch/*/spec.md` 及相关 ADR），识别需求缺失、未批准范围蔓延与实现错误。

两轴严格独立审查，互不混淆、互不稀释。

---

## 2. Standards (规范与代码异味轴)

### 2.1 文档规范硬违规 (Documented Standards Violations)

#### 1. 入站应用标识符归一化遗漏 (Inbound App ID Normalization Omission)
- **违规标准**: [`docs/adr/0010-canonical-app-identifier.md`](file:///Z:/rust_workplace/z-store/docs/adr/0010-canonical-app-identifier.md#L34-L39) §5 *入站归一化系统边界契约*（所有由外部输入、深链及 IPC 命令传入的 `app_id` 必须在入口处经 `canonical_app_id()` 归一化）。
- **违规代码位置**:
  - [`src-tauri/src/commands/updates.rs`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L502-L541)：
    - [`set_app_skip_version`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L502)
    - [`set_app_frozen`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L514)
    - [`set_app_hidden`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L526)
    - [`remove_update_rule`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L538)
    上述四个更新规则配置命令直接接收未清洗的原始 `app_id: String`，并直接写入本地 SQLite，完全绕过了 `canonical_app_id()` 归一化校验。
  - [`src-tauri/src/commands/installer.rs`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/installer.rs#L392-L399)：
    - [`unmanage_app`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/installer.rs#L392) 直接将未归一化的 `app_id: String` 传入 `remove_installed_app`。

#### 2. 日志级别错位与循环内违规打点 (Logging Level & Loop Point Violations)
- **违规标准**: [`docs/logging.md`](file:///Z:/rust_workplace/z-store/docs/logging.md#L90-L139) §10 *三层业务打点定稿：终端失败必为 error，单仓成功禁止 info，循环内禁 info*。
- **违规代码位置**:
  - [`src-tauri/src/commands/installer.rs`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/installer.rs#L382)：卸载失败分支使用 `log::warn!("uninstall failed for app {}: {}", app_id, e)`，违反“终端失败必须为 error”的标准，且打点位于命令层而非指定的 [`src-tauri/src/installer/executor.rs`](file:///Z:/rust_workplace/z-store/src-tauri/src/installer/executor.rs)。
  - [`src-tauri/src/commands/updates.rs`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L174-L189)：在流式更新检查的并发循环体内，对每次 200/304 结果均调用 `log::info!("http resp update id=...")`，直接违反“循环内禁止 info”和“单仓成功禁止 info”的日志防刷屏硬性规则。

---

### 2.2 基础代码异味判定 (Baseline Fowler Code Smells)

#### 1. 基本类型偏执 (Primitive Obsession)
- **涉及模块**: [`src-tauri/src/commands/*`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L502)
- **现象分析**: 全系统所有 IPC 命令签名均使用裸 `String` 传递应用标识，缺乏领域强类型 `CanonicalAppId` 封装：
  ```rust
  pub fn set_app_skip_version(state: State<'_, AppState>, app_id: String, ...) -> Result<bool, String>
  ```
  正是因为缺乏强类型保障，才导致 ADR-0010 归一化在多个更新与卸载命令入口被遗漏。
- **重构建议**: 引入 Newtype `struct CanonicalAppId(String)`，强制在入站反序列化或构造时执行 `canonical_app_id` 验证。

#### 2. 发散式变化 (Divergent Change)
- **涉及模块**: [`src/App.tsx`](file:///Z:/rust_workplace/z-store/src/App.tsx#L1-L1375)
- **现象分析**: 单个组件代码量达 1,375 行，同时承载路由调度、全局 Toast、平台双维过滤状态管理、Tauri 后台推流监听、更新轮询以及 5 个以上全局 Modal 的开闭逻辑。任何无关的需求变动（如更新动效、弹窗微调、快捷键捕获）均导致该文件被修改。
- **重构建议**: 将各类 Modal 状态抽象为独立 Context/Hook，拆分事件订阅（`useTauriEventListener`）与路由渲染逻辑。

#### 3. 重复代码 (Duplicated Code)
- **涉及模块**: [`src-tauri/src/commands/updates.rs`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/updates.rs#L502-L536)
- **现象分析**: 更新规则命令组存在大量重复的数据库锁获取和错误映射模版代码：
  ```rust
  let db = state.db.lock().map_err(|e| e.to_string())?;
  db.set_...(&app_id, ...).map_err(|e| e.to_string())?;
  Ok(true)
  ```
- **重构建议**: 提炼数据库操作事务/闭包辅助函数统一处理锁与错误。

#### 4. 夸夸其谈未来性 / 冗余假抽象 (Speculative Generality)
- **涉及模块**: [`src-tauri/src/commands/catalog.rs`](file:///Z:/rust_workplace/z-store/src-tauri/src/commands/catalog.rs#L152-L159)
- **现象分析**: 保留了无实际逻辑的死命令桩（Stub），参数未被使用且直接返回常量 0：
  ```rust
  pub async fn warmup_top_apps(_state: State<'_, AppState>, _limit: Option<usize>) -> Result<usize, String> {
      Ok(0)
  }
  ```
- **重构建议**: 彻底清除该 IPC 命令或补齐真实的预热逻辑。

---

## 3. Spec (功能契约与规格实现轴)

### 3.1 缺失或不完整的需求 (Missing or Partial Requirements)

1. **界面多语言与国际化 (Interface i18n) 完全缺失**
   - **规格出处**: `docs/design/应用需求报告.md` FR-9.3
   > `| FR-9.3 | 外观：深浅色主题（跟随系统）、界面语言（简中/英文） | P0 | 全部界面文案走 i18n |`
   - **现状**: `src/` 下全量前端组件均为硬编码中文，未引入任何 i18n 框架（如 `react-i18next`），英文语言切换功能完全缺失。

2. **Android Shizuku 静默安装预研方案缺失**
   - **规格出处**: `.scratch/feature-deep-link/spec.md` L36-37
   > `4. Android Shizuku 静默安装预研方案: 详尽阐述 Android 11+ 架构下基于 Binder 与 Shizuku Server 提权进行 PackageInstaller.Session 静默分包安装的架构设计与实现原型。`
   - **现状**: 文档和代码中均未包含 Shizuku 提权安装方案的可用原型设计与架构论证。

3. **历史版本 / 降级安装功能缺失**
   - **规格出处**: `docs/design/应用需求报告.md` FR-4.5
   > `| FR-4.5 | 降级/历史版本安装：从版本列表选择历史版本安装 | P1 | 明确警告"降级可能导致数据不兼容" |`
   - **现状**: 当前详情页仅提供最新 Release 的构建资产下载与安装，完全没有历史版本列表浏览与降级安装能力。

4. **开发者画像缺少 ETag 缓存联动 (Partial)**
   - **规格出处**: `.scratch/feature-dev-ecosystem/spec.md` L12
   > `- 联动 ETag 缓存，提供 Tauri IPC 命令 get_developer_profile(developer: String)。`
   - **现状**: `fetch_developer_profile` 直接向 GitHub 发送普通 HTTP GET 请求，未走 SQLite 的 `etag_cache` 条件请求，浪费 API 配额。

---

### 3.2 范围蔓延与未定义行为 (Scope Creep)

1. **超出原始规格的自研 `z_log` 日志框架**
   - **现状**: 在无明确前置需求规格定义的情况下，跨 14+ 次 Commit 实现了包含会话级打点追踪、自定义 Tar 导出包（`zlog_export_bundle`）、崩溃 Panic Hook 的重型日志子系统。
2. **商业化与生态变现白皮书与开源基石冲突**
   - **规格约束**: `CONTEXT.md` L48-49 架构不变量 D1
   > `D1 纯粹开源 (Strictly FLOSS): ... 严禁集成任何闭源专有软件包或商业广告推广。`
   - **现状**: 引入了 `docs/design/商业化战略与低频破局思考.md`，其中的商业变现论述与开源非盈利的核心定位发生偏离。
3. **已安装扫描破坏性静默清除 (Destructive Ghost App Purging)**
   - **规格出处**: `docs/design/应用需求报告.md` FR-5.3
   > `只读扫描，不修改任何系统状态`
   - **现状**: 在调用 `get_installed_apps` 时，后端一旦探测到本地执行文件不存在，会静默直接执行 `DELETE FROM installed_apps` 删除本地数据库记录，违背了扫描接口只读契约。

---

### 3.3 实现偏离与错误行为 (Implemented but Incorrect)

1. **macOS PKG 执行行为错误**
   - **规格出处**: `.scratch/feature-deep-link/spec.md` L30
   > `- .pkg: 调用 installer -pkg <path> -target CurrentUserHomeDirectory；`
   - **现状**: 实际代码执行了 GUI `open -W` 弹出图形安装器，而非规格要求的 headless CLI 指定安装至当前用户目录。

2. **Linux AppImage 部署未到位**
   - **规格出处**: `.scratch/feature-deep-link/spec.md` L32
   > `- .AppImage: chmod +x -> 移动至用户可执行路径（如 ~/.local/bin）-> 自动生成 .desktop 快捷方式桌面项；`
   - **现状**: 仅对下载的原地路径执行了启动，未迁移至 `~/.local/bin`，亦未生成系统级 `.desktop` 图标快捷方式。

3. **Windows Setup EXE 静默安装参数缺失**
   - **规格出处**: `docs/adr/0004` L19
   > `- Windows Setup EXE: 自动探测 NSIS (/S) 或 InnoSetup (/VERYSILENT /NORESTART) 参数。`
   - **现状**: 安装器直接拉起进程，未做安装包类型嗅探，未传递任何静默安装参数。

4. **非 Windows 平台 MSI 虚假返回成功**
   - **规格出处**: `docs/adr/0004` L17 多平台安装引擎与系统提权规范
   - **现状**: 在非 Windows 系统下调用 MSI 安装逻辑直接返回 `Ok(InstalledApp { ... })`，将完全未安装的软件写入了本地数据库。

5. **标星同步中 Releases 状态硬编码伪造**
   - **规格出处**: `.scratch/feature-dev-ecosystem/spec.md` L21
   > `- 过滤与匹配：交叉比对收录库或检索仓库 Releases，筛选出具备可执行文件的开源软件；`
   - **现状**: 对不在精选收录库中的外部仓库，未通过 API 实际查询，直接硬编码 `has_releases: false`，导致外部标星项目永远无法被识别为可安装软件。

---

## 4. 双轴综合结论与改进建议

### 一行汇总
- **Standards 轴**: 共发现 **6** 项问题（2 项硬违规，4 项代码异味），最严重问题为 **更新规则与卸载 IPC 命令未执行 Canonical App ID 归一化**。
- **Spec 轴**: 共发现 **12** 项问题（4 项缺失/不完整，3 项范围蔓延，5 项实现偏离），最严重问题为 **跨平台安装器执行逻辑缺失静默参数及非 Windows 平台假冒 MSI 安装成功**。

### 建议整改优先级队列 (P0 - P2)
- **[P0] 安全与数据完整性修复**:
  1. 为 `set_app_skip_version` 等 4 个命令及 `unmanage_app` 接入 `canonical_app_id` 校验。
  2. 修复非 Windows 平台 MSI 逻辑，非目标平台直接返回平台不支持错误。
  3. 修复 `get_installed_apps` 的破坏性静默删除问题，改为标记 `missing: true` 视图态。
- **[P1] 规范合规治理**:
  1. 纠正 `installer.rs` 卸载日志为 `error` 级别并下沉至执行器；清理流式更新中的高频循环 `info` 日志。
  2. 修复 macOS `.pkg` 与 Linux `.AppImage` 的标准安装流程。
- **[P2] 体验与架构演进**:
  1. 拆分 `App.tsx` 超大组件，解耦 Modal 与全局事件。
  2. 引入 `react-i18next` 落地 FR-9.3 多语言界面。
