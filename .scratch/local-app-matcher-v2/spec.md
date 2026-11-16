# Feature Spec: 存量应用管理匹配引擎 v2 —— 内存倒排索引、词/路径边界防误报与多源跨平台发现（Local App Matcher v2）

> 状态：Draft
> 关联契约：`CONTEXT.md`（§35 存量应用管理、§13 多端应用标识符、§24 已安装应用、§25 我的应用、§44 规范应用标识；D1–D4 核心边界）、ADR-0009（独立生态清单仓库解耦）、ADR-0010（规范应用标识）、ADR-0022（「我的应用」合并已安装与更新视图）、`docs/count-display.md`（数量显示规范）。

---

## 1. 背景与现状瓶颈

ZStore 的**存量应用管理**（`src-tauri/src/scanner/`、`src-tauri/src/commands/scanner.rs`、`src/components/AppImportModal.tsx`）负责扫描宿主操作系统已安装软件、与**精选收录库**（含**本地库** overlay）匹配打分并一键纳管更新。结合真实 `catalog.json` 与跨平台运行场景审查，现行实现存在 **4 类结构性缺陷**：

### 1.1 裸子串匹配与搜索别名混用导致高分误匹配（False Positives）
- **无词边界与路径段边界**：`scanner/matcher.rs` 在名称侧使用裸 `starts_with`（`+0.42`）与双向 `contains`（`+0.32`），在路径侧（第 118、137 行）保留了 `s_loc.contains(&c_repo)` 与 `s_loc.contains(&dir_lower)` 裸子串匹配，且对 `min`、`ice`、`mos`、`rio`、`itch`、`zed` 等短名未设长度与交叉验证门槛。例如本机 `C:\Users\admin\miniconda3` 下的 `Miniconda3` 对 `minbrowser/min` 得 `0.42 + 0.20 = 0.62` 分（直接跨过 `AppImportModal` 的 `0.60` 默认勾选线）；`WPS Office` 对 `jordanbaird/ice` 得 `0.32 + 0.20 = 0.52` 分；`Factorio` 误中 `raphamorim/rio`、`Twitch` 误中 `itchio/itch`。
- **搜索联想词/竞品平替词污染**：`catalog.json` 的 `aliases` 同时承载商店搜索职责，包含闭源竞品名（`rustdesk` 含 `"anydesk"`、`keepassxc` 含 `"1password"`、`vscodium` 含 `"vscode"`、`floorp` 含 `"firefox"`、API 工具含 `"postman"`）及泛化品类词（`"ide"`、`"code"`、`"git"`、`"terminal"`）。`s_name.contains(alias)` 给 `+0.35` 分导致安装 `"Microsoft Visual Studio IDE"` 因命中 `"ide"` + `"Microsoft"` 发布者得 `0.60` 分被误判为 `VS Code`。
- **同源衍生版（Fork）抢占与跨平台未预筛**：官方原版 `7-Zip 24.08 (x64)` 因前缀/发布者/主程序命中 `mcmilk/7-zip-zstd` 高达 `0.87` 分，纳管更新会覆盖或双装污染原版；同时 `matcher.rs` 未按 `CatalogItem::current_platform_key()` 过滤 `cat.platforms`，纯 macOS/Linux 条目在 Windows 上仍参与打分。

### 1.2 名称后缀未降噪、权重倒挂、安装包名污染与扫描源单一导致漏检（False Negatives）
- **注册表 `DisplayName` 噪声后缀压低得分**：`"Motrix 1.8.19"`、`"Notepad++ (64-bit x64)"`、`"Microsoft Visual Studio Code (User)"` 因尾随版本号、架构或安装作用域无法命中精确名称（`0.55`），退化为 `0.42`（低于及格线 `MIN_QUALIFIED_SCORE = 0.45`）甚至 `0.0`。
- **强弱信号权重倒挂**：非通用名的原生主程序精确命中（如 `obs64.exe`、`KeePassXC.exe`、`SiYuan.exe`）是最硬的物理证据，却与模糊目录同权仅给 `0.20` 分（注册表中文名 `"思源笔记"` 配 `SiYuan.exe` 因 `0.20 < 0.45` 漏检）；而 `SCORE_VERSION_MATCH = 0.10` 在旧版待升级主场景下极少命中，反而帮 `"1.0.0"` 等通用版本号凑分。
- **`identifiers.windows` 资产包名污染 + 候选派生互斥**：`catalog.json` 中有 43 个条目的 `identifiers.windows` 误填了 Release 安装包文件名（如 `npp.8.9.8.Installer.arm64.exe`、`GitHubDesktopSetup-x64.exe`、`rio-portable-aarch64.exe`），而 `ScanConfig::from(&CatalogItem)` 仅在 `identifiers.windows.is_empty()` 时才调用 `exe_candidates(&cat.repo)`，断掉了真实主程序回退。
- **扫描源单一**：Windows 仅扫注册表 `Uninstall`（漏掉 Scoop、开始菜单 `.lnk` 绿色软件，且丢弃了注册表子键名 `key_name` 与 `UninstallString` 父目录）；macOS `scan_system_apps()` 为空实现 `Vec::new()`。

### 1.3 路径解析、编码、辅助二进制过滤与版本判定的确定性 Bug
1. **Linux `.desktop` 误读规范版本**：`scan_linux_desktop()` 将 Freedesktop 规范版本 `Version=1.0` 当作软件版本写入 `display_version`，导致 Linux 导入应用普遍显示 `v1.0` 并永久假报更新。
2. **`clean_display_icon` 引号包裹 `,0` 失败**：`"C:\Program Files\App\app.exe,0"` 因 `if ... else if` 分支互斥未剥离 `,0` 返回 `None`；`DisplayIcon` 为 `.lnk` 时 `resolve_executable_path` 未继续调用 `resolve_lnk_target` 解出目标 `.exe`。
3. **`.lnk` 不支持中文/Unicode 路径**：`lnk_target.rs` 仅按 UTF-8 解析 ANSI `LocalBasePath`（中文 Windows 下 GBK 必败）且启发式分支限制 `byte < 127`，未读 `LocalBasePathUnicode` 与 Unicode `StringData`，导致中文用户名或中文安装路径下的快捷方式 100% 断链。
4. **路径黑名单误伤与目录首 `.exe` 盲取**：`is_installer_or_cache_path` 对全路径做裸 `contains("temp" | "unins" | "installer" | "bundle")`，误杀 `temp*` 用户名、`Core Temp` 以及已收录的 `Bulk-Crap-Uninstaller.exe`，却漏放了 Squirrel `Update.exe`、`crashpad_handler.exe`、`elevate.exe`；配合 `find_exe_in_directory` 第 4 步盲取根目录首个 `.exe`，易把辅助进程当主程序。
5. **WiX 组件路径裸 `contains` 串味**：`registry.rs` 用 `HashMap` + `app_lower.contains(comp_name)` 回填 `InstallLocation`，短名 MSI 子组件会污染无关 NSIS 应用。
6. **双段版本号更新漏判**：`Notepad Next` (`v0.15`) / `Playnite` (`10.37`) 经 PE `VS_FIXEDFILEINFO` 格式化为三段 SemVer `"0.15.0"`，而远端 tag `"v0.16"` 非三段 SemVer，`is_version_newer` 因单侧可解析直接返回 `false`。

### 1.4 算法复杂度、重复 I/O 与前端确认可解释性不足
- **`O(N × M)` 重复分配与后置过滤**：`CONTEXT.md` §35 约定了「倒排索引与启发式打分」，但现行 `match_apps` 为双层全表循环且内层每次重复 `to_lowercase()` 与克隆 `identifiers`，并在完成磁盘探测与 PE 读取后才过滤 `installed_ids`。
- **`get_installed_apps` 同步重复扫注册表**：`commands/installer_query.rs` 第 61 行刚缓存 `registry_entries`，第 76 行 `resolve_app_installed_at` 又在主线程同步对每个 `system_import` 应用重扫 3 棵注册表卸载根键。
- **导入确认弹窗信息缺失**：`AppImportModal.tsx` 未展示本机检测原名 `scanned.display_name` 与匹配依据，`low` 档置信度无警示区分，且默认勾选阈值 `0.60` 偏激进。

---

## 2. ADR 契约兼容性声明

本方案严格遵循 `CONTEXT.md` **D1–D10** 全部核心架构边界（纯客户端零网络本地扫描、规范应用标识 `Canonical App Id` 归一、D4 Linear 去彩单色设计规范、`docs/count-display.md` 数量显示规范、IPC 请求键 `camelCase` / 响应字段 `snake_case`、视图层禁直调 `invoke`），不与任何既有 ADR 冲突；完成后新增 **ADR-0028** 固化存量应用匹配引擎 v2 契约。

---

## 3. 目标架构设计

### 3.1 四阶段流水线总览

```text
[阶段 1：多源系统软件采集 scan_system_apps]
  ├─ Windows：注册表三根键字段合并 + 子键名采集 + UninstallString 父目录推导 + WiX 严格对齐
  │          + Scoop (~/scoop/apps/*/current/manifest.json) + 开始菜单独立 .lnk 去重补盲
  ├─ Linux  ：7 类 XDG .desktop（禁读规范 Version=，认 X-AppImage-Version= + dpkg/rpm 反查真实版本）
  │          + ~/Applications & ~/AppImages 裸 AppImage 补盲
  └─ macOS  ：/Applications & ~/Applications/*.app/Contents/Info.plist（纯 Rust XML 解析 + plutil 兜底）
        │
        ▼
[阶段 2：预过滤与内存倒排索引构建 CatalogMatchIndex::build]
  ├─ 前置剔除：已纳管 installed_ids（canonical_lookup_id）+ 不支持当前宿主平台的 CatalogItem
  ├─ 标识符净化：剔除 Setup/Installer/版本架构形态的安装包资产名，保留原生主程序并追加 repo/name 派生候选
  └─ 四路倒排桶：name_token → [idx] | exe_stem → [idx] | dir_segment → [idx] | publisher_token → [idx]
        │
        ▼
[阶段 3：边界安全多信号精排与全局二分一对一分配]
  ├─ DisplayName 降噪归一化（剥离版本号、x64/arm64、User/Machine/MSI、_is1 等后缀）
  ├─ 四维正交信号打分 + 短名交叉佐证门禁 + 同源衍生版（Fork）变体词惩罚守卫 + 生成 match_reasons
  └─ 全局按 (confidence, has_curated_exe, exact_name, name_len) 降序一对一贪心指派（零顺序偏置）
        │
        ▼
[阶段 4：落盘主程序核验、Unicode .lnk 解构与可解释确认 UI]
  ├─ 严格落盘门禁：Squirrel app-* 最新子目录优先、禁多二进制目录盲取首 exe、禁跨目录张冠李戴回填
  └─ AppImportModal：默认仅勾选 high (>=0.70)、展示本机原名与匹配依据标签、三档置信度单色分层呈现
```

---

### 3.2 关键算法契约

#### 3.2.1 `DisplayName` 与标识符净化规则
1. **本地名称归一化（`normalize_app_title`）**：
   - 转小写、去首尾空白，剥离括号内的架构/作用域/语言标注：`(x64)`、`(x86)`、`(64-bit)`、`(32-bit)`、`(arm64)`、`(user)`、`(machine)`、`(all users)`、`(msi)` 及 `(x64 zh-cn)` 等组合；
   - 剥离尾随独立架构词（`x64`、`x86`、`win64`、`arm64`、`64-bit`）与尾随版本号 token（匹配 `^v?\d+(\.\d+)+([+-][a-z0-9._-]+)?$`）；
   - 注册表 `registry_key` 额外剥离 Inno Setup `_is1` 后缀，忽略纯 `{GUID}` 键名。
2. **安装包资产名识别与运行时自愈（`is_installer_asset_identifier`）**：
   - 当 `identifiers.windows` 中的候选名命中安装器打包特征（如含 `setup`、`installer`、`.paf.exe`、或内嵌版本号/架构段 `-\d+\.\d+` / `-win32-` / `-win64` / `-arm64` / `-x64`，**但排除**应用自身 `repo` 或 `name` 本就包含 `uninstaller`/`setup` 的情形，如 `Bulk-Crap-Uninstaller.exe`）时，在匹配与寻址中将其降级剔除；
   - `ScanConfig::from(&CatalogItem)` 始终将 `exe_candidates(&cat.repo)` 与基于 `cat.name` 派生的 `.exe` 候选去重追加在精校 `identifiers` 之后，彻底修复非空 `identifiers` 阻断默认回退的问题；同步清洗根仓库 `catalog.json` 中的 43 处安装包资产名并在 `config.rs` 单测加锁。

#### 3.2.2 倒排索引与防误报打分模型（`src-tauri/src/scanner/matcher.rs`）

对候选对 `(scanned, entry)` 计算四维得分与结构化 `match_reasons`（键枚举：`"exact_name"`、`"prefix_name"`、`"alias"`、`"executable"`、`"install_dir"`、`"publisher"`、`"bundle_id"`、`"version"`）：

| 信号维度 | 判定契约（全词元 / 路径段边界，严禁裸子串 `contains`） | 分值 | 防误报守卫 |
|---|---|---|---|
| **1. 原生主程序 / Bundle 标识** | `display_icon`、`install_location` 主程序文件名精确命中精校 `identifiers`（非停用词），或 `registry_key` / macOS `CFBundleIdentifier` / Linux desktop stem 精确命中应用包标识 | **`+0.48`**（精校专属主程序/Bundle ID）<br>**`+0.30`**（repo 派生主程序） | 仅认文件名边界（`path_matches_candidate`）；通用名（如 `app.exe`、`launcher.exe`、`code.exe`、`terminal.exe`）降为 `+0.30`，须叠加名称或发布者才过线 |
| **2. 应用名称匹配** | 归一化全名精确相等（含 `cat.name`、`cat.repo`、`registry_key` 去后缀，以及 `description_en` 为 `≤4` 词短产品标题时的精确相等，如 `"visual studio code"`） | **`+0.55`**（常规名 `len ≥ 4`）<br>**`+0.38`**（短名 `len ≤ 3`） | **短名门禁**：`len ≤ 3`（如 `min`、`ice`、`mos`、`rio`、`zed`）单靠名称最高 `0.38 < 0.45`，必须有主程序、路径段或发布者交叉佐证才能入围 |
| **2b. 词边界前缀 / 词序列包含** | 仅当被匹配词序列 `len ≥ 4` 且严格落在词元边界上（如 `"vlc media player"` 词首命中 `"vlc"` 不走此项而走精校别名/主程序；`"obs studio"` 完整词元匹配） | **`+0.42`**（词边界前缀）<br>**`+0.32`**（完整多词元序列） | `"miniconda3"` 绝不命中 `"min"`；`"wps office"` 绝不命中 `"ice"`；`"factorio"` 绝不命中 `"rio"`；**变体/Fork 惩罚**：若 `cat.name`/`cat.repo` 含有 `scanned` 名称与路径均不具备的衍生变体后缀词（如 `zstd`、`next`、`rev`、`nyanpasu`、`codium`），扣减 **`-0.35`** |
| **2c. 安全别名精确匹配** | 归一化名称与清洗后的 `safe_aliases` **整词/整短语精确相等**（禁子串 `contains`） | **`+0.38`** | 索引构建期剔除 `CANDIDATE_STOP_WORDS`、品类泛词（`ide`、`code`、`git`、`ssh`、`api`、`browser` 等）、含 `"替代"` 字样词条、与其他收录项同名的词及已知闭源竞品名（`anydesk`、`1password`、`postman`、`teamviewer`、`alfred`、`bartender` 等） |
| **3. 安装目录段匹配** | `install_location`（含由 `UninstallString` 反推的目录）路径组件精确等于 `install_dirs` 或 `cat.repo`（`len ≥ 4`；若主程序未命中时计入，不与信号 1 全额双计） | **`+0.22`**（独立命中）<br>**`+0.10`**（主程序已命中时叠加） | 必须按 `/`、`\` 路径组件边界比对，`C:\Users\admin\...` 绝不命中 `min` |
| **4. 发布者 / 组织佐证** | `publisher` 词元与 `cat.owner` 或 `cat.publishers` 精确相等或词边界包含（过滤 `inc`、`llc`、`ltd`、`corp`、`corporation`、`team`、`project`、`studio`、`dev` 等组织后缀停用词） | **`+0.22`** | 空串或停用词后为空一律 `0` 分 |
| **5. 非平凡版本一致微调** | 仅当（信号 1 > 0 或 信号 2 > 0）且 `s_ver == c_ver` 且版本非 `"1.0"` / `"1.0.0"` / `"0.1.0"` 时加分 | **`+0.05`** | 绝不允许无名称/主程序命中的条目靠版本号凑分 |

置信度门槛保持 `MIN_QUALIFIED_SCORE = 0.45`、中置信度 `0.55`、高置信度 `0.70`；**前端默认勾选阈值收紧至 `confidence >= 0.70`（即仅 `high` 档默认勾选）**。

#### 3.2.3 路径解构、版本修复与跨平台发现契约
1. **`clean_display_icon` 与 `.lnk` Unicode 解构**：
   - `clean_display_icon` 改为**串行两步**：先剥离首尾对称引号（兼容 `"path,0"` 与 `"path",0` 两种形态），再剥离末尾 `,[-0-9]+` 图标索引；`resolve_executable_path` 遇到 `.lnk` 时优先调用 `resolve_lnk_target` 解出落盘 `.exe`。
   - `lnk_target.rs` 升级：
     1. 结构化读取 `LinkInfo`：当 `link_info_header_size >= 0x24` 时优先读取 UTF-16LE 的 `LocalBasePathUnicode`（拼接 `CommonPathSuffixUnicode`）；ANSI `LocalBasePath` 在 Windows 下经 `MultiByteToWideChar(CP_ACP, ...)` 解码以完整支持 GBK 中文路径；
     2. 解析紧随其后的 `StringData`（按 `HasName` / `HasRelativePath` / `HasWorkingDir` 顺序读取 `IsUnicode` 计数宽字符串或 ANSI 字符串），当目标在移动盘或相对路径时组合 `WorkingDir`（或 `.lnk` 所在父目录）+ `RelativePath` 校验落盘文件；
     3. 启发式兜底同时支持 UTF-16LE 宽字节盘符模式与 ASCII 模式。
2. **辅助进程黑名单与 Squirrel 目录寻址（`display_icon.rs`）**：
   - 将 `is_installer_or_cache_path` 拆分为**目录段缓存判定**（检查路径各 `Component` 是否为 `temp`、`tmp`、`package cache`、`windows\installer`、`squirreltemp`、`~nsu.tmp` 等，不再误伤 `C:\Users\tempuser` 或 `Core Temp`）与**辅助二进制文件名判定**（拦截 `unins*`、`*setup*`、`*installer*`、`update.exe`、`updater.exe`、`squirrel.exe`、`elevate.exe`、`crashpad_handler.exe`、`createdump.exe`，**除非**该文件名正是当前 `ScanConfig.target_executables` 显式声明的目标主程序，从而放行 `Bulk-Crap-Uninstaller.exe`）；
   - `find_exe_in_directory` 原生识别 Squirrel `app-<ver>` 子目录（按版本号降序取最新目录内的主程序），且根目录回退（第 4 步）仅在目录内**唯一**非辅助 `.exe` 或文件名词干命中配置词元时才采纳，禁止在多二进制目录盲取首个无关 `.exe`。
3. **跨平台版本与注册表复用**：
   - Linux `scan_linux_desktop()` 彻底忽略 `.desktop` 的规范 `Version=` 字段，仅认 `X-AppImage-Version=`；版本为空且已定位到二进制路径时，经 `dpkg-query` / `rpm -qf` 批量或按需反查真实上游包版本（剥离 Debian epoch `N:` 与发行版修订后缀 `-ubuntu*`/`-deb*`）；
   - macOS 新增 `scanner/macos.rs`：扫描 `/Applications` 与 `~/Applications` 下 `*.app/Contents/Info.plist`，提取 `CFBundleDisplayName`/`CFBundleName`、`CFBundleIdentifier`、`CFBundleShortVersionString` 与 `CFBundleExecutable`；
   - `updates_check.rs::is_version_newer` 支持双段纯数字版本（如 `0.15`、`10.37`）与三段 SemVer（`0.15.0`、`10.37.0`）对齐比较，消除 PE 四段版本资源补零导致的漏报；
   - `commands/installer_query.rs::get_installed_apps` 直接复用单次枚举的 `registry_entries` 反查 `installed_at`，删除主线程 `O(K × R)` 重复注册表扫描。

---

## 4. IPC、UI 与架构门禁合规说明

- **IPC 契约向后兼容（`AGENTS.md`）**：
  - 命令名 `scan_and_match_local_apps` 与 `import_matched_apps` 及请求参数完全不变；
  - 响应结构体 `ScannedRawApp` 新增可选 `snake_case` 字段 `registry_key: Option<String>`、`source_kind: Option<String>`，`AppMatchResult` 新增 `match_reasons: Vec<String>`（均带 `#[serde(default)]`）；
  - 前端视图层继续通过 `tauriApi` 调用，严禁直接导入 `api/client` 或 `invoke`。
- **D4 单色规范与 `docs/count-display.md` 合规**：
  - `AppImportModal.tsx` 遵循 Linear 去彩单色界面：置信度标签区分 `high`（高置信度，默认勾选）、`medium`（中等置信度，默认不勾选）、`low`（低置信度，带告警色点缀提醒核验、默认不勾选）；
  - 当 `scanned.display_name` 与 `item.name` 不一致时显式展示本机检测原名，并展示由 `match_reasons` 映射的精简匹配依据标签；
  - 严禁新增任何括号计数文案（如 `({{count}})`）或自造计数样式类，确保 `countDisplay.test.ts` 100% 通过。

---

## 5. 实施 Issue 拆分与依赖拓扑

```text
[01 路径/图标解构、Unicode .lnk、辅助进程过滤、双段版本比较与安装包标识符净化]
        │
        ▼
[02 多源跨平台系统发现（Windows Scoop/快捷方式/注册表合并、Linux 真实包版本、macOS .app）与注册表快照复用]
        │
        ▼
[03 内存倒排索引、词/路径边界防误报精排引擎、Fork 惩罚与全局一对一指派]
        │
        ▼
[04 导入确认弹窗本机原名对照、匹配依据展示、三档置信度交互与 Demo 样例对齐]
        │
        ▼
[05 真实清单对抗评测基准（零误报/高召回）、ADR-0028、领域文档同步与全量回归门禁]
```

1. [`01-path-lnk-version-and-identifier-hygiene.md`](./issues/01-path-lnk-version-and-identifier-hygiene.md)（`ready-for-agent`，`Blocked by: none`）
2. [`02-multi-source-discovery-and-registry-reuse.md`](./issues/02-multi-source-discovery-and-registry-reuse.md)（`ready-for-agent`，`Blocked by: 01`）
3. [`03-inverted-index-and-boundary-safe-matcher.md`](./issues/03-inverted-index-and-boundary-safe-matcher.md)（`ready-for-agent`，`Blocked by: 01, 02`）
4. [`04-import-modal-explainability-and-tier-ux.md`](./issues/04-import-modal-explainability-and-tier-ux.md)（`ready-for-agent`，`Blocked by: 03`）
5. [`05-catalog-eval-suite-adr-0028-and-regression-gates.md`](./issues/05-catalog-eval-suite-adr-0028-and-regression-gates.md)（`ready-for-agent`，`Blocked by: 01, 02, 03, 04`）

---

## 6. 整体验收标准

- **零误报底线（Adversarial Precision）**：针对真实 `catalog.json`，本机存在 `Miniconda3`（位于 `C:\Users\admin\...`）、`WPS Office`、`Microsoft Office`、`Microsoft Visual Studio IDE`、`Factorio`、`Twitch`、`Dolby Atmos`、`AnyDesk`、`1Password`、`Postman`、`Mozilla Firefox`、`Epic Games Launcher`、官方原版 `7-Zip 24.08 (x64)` 时，误匹配数为 **0**。
- **高召回与跨平台准确性（Recall & Fidelity）**：
  - 带版本号/架构/作用域的 `"Motrix 1.8.19"`、`"Microsoft Visual Studio Code (User)"`、`"Notepad++ (64-bit x64)"`、Squirrel 结构 `"GitHub Desktop"`、中文名配英文主程序的 `"思源笔记"` (`SiYuan.exe`)、卸载类开源工具 `"Bulk Crap Uninstaller"` 全部精准命中且定位到真实主程序（不误取 `Update.exe` 或 `crashpad_handler.exe`）；
  - 中文目录/中文用户名下的 `.lnk` 快捷方式、引号包裹 `,0` 的 `DisplayIcon` 均正确解析；
  - Linux `.desktop` 的 `Version=1.0` 不再污染 `local_version`；双段版本号（`v0.15` → `v0.16`）与 PE 三段版本号（`0.15.0`）正常检出更新；macOS `/Applications/*.app` 可正常扫描识别。
- **性能与交互可解释性**：
  - 匹配引擎通过 `CatalogMatchIndex` 倒排检索并前置过滤已纳管与非本平台条目，匹配循环零冗余字符串小写化/Vec 克隆；`get_installed_apps` 对 `system_import` 应用至多枚举一次注册表；
  - `AppImportModal` 默认仅勾选 `high` 档（`>= 0.70`），清晰呈现本机原名与匹配依据，符合 D4 单色规范与 `docs/count-display.md`。
- **全量质量门禁**：
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `npx vite build --config vite.demo.config.ts`
  全部零警告、零错误通过。
