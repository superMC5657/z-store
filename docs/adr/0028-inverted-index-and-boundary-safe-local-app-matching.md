# ADR-0028：存量应用匹配引擎——多源发现、内存倒排索引与边界安全打分

- 状态：Accepted
- 日期：2026-11-16
- 关联：ADR-0009（独立生态清单仓库）、ADR-0010（规范应用标识）、ADR-0022（「我的应用」合并已安装与更新视图）
- 落地计划：`.scratch/local-app-matcher-v2/`
- 实现：`src-tauri/src/scanner/`（`registry.rs`、`executable.rs`、`macos.rs`、`display_icon.rs`、`lnk_target.rs`、`types.rs`、`matcher.rs`、`mod.rs`、`version.rs`）、`src-tauri/src/commands/installer_query.rs`、`src-tauri/src/commands/updates_check.rs`、`src/components/AppImportModal.tsx`、`src/demo/handlers/catalog.ts`

## 1. 背景

存量应用管理把宿主系统已安装的软件与精选收录库对上号，再一键纳管更新。匹配错了（把 Miniconda 当成 Min 浏览器、把官方 7-Zip 当成 7-Zip-zstd）会让后续更新覆盖用户的软件；匹配漏了（`Motrix 1.8.19`、`思源笔记`）则用户无从纳管。收录库的 `aliases` 同时服务商店搜索，里面有闭源竞品名与品类泛词，不能直接当身份证据。

## 2. 决策

### 2.1 阶段 1：多源发现（`AppScanner::scan_system_apps`）

`ScannedRawApp` 带 `registry_key`（系统侧应用包标识）与 `source_kind`（发现来源）两个可选字段。

- **Windows**：
  - 三棵卸载注册表根（HKLM、Wow6432Node、HKCU）按 `(小写名称, 版本)` 合并，后出现的根只补缺失字段；子键名去 `_is1` 后记为 `registry_key`，纯 `{GUID}` 键不记；
  - 缺 `InstallLocation` 时由 `UninstallString` 的可执行文件所在目录推导（拒绝 msiexec、rundll32、cmd、powershell、系统目录、缓存目录、盘符根与顶层 Program Files），再由 WiX 子组件回填（组件名与应用名相同，或双方均不短于 6 个字符且在词边界上互为前缀）；
  - 补扫 Scoop（`$SCOOP`、`%USERPROFILE%\scoop`、`$SCOOP_GLOBAL`、`%ProgramData%\scoop` 下 `apps/*/current/manifest.json`）与开始菜单（根 + 一级子目录）中未被注册表/Scoop 覆盖的 `.lnk` 绿色软件。
- **Linux**：`.desktop` 只读 `[Desktop Entry]` 节，忽略规范版本 `Version=`，只认 `X-AppImage-Version=`；版本缺失且主程序位于 `/usr`、`/bin`、`/opt` 时批量 `dpkg-query`（无 dpkg 时逐个 `rpm -qf`）反查上游版本（去 epoch 与发行版修订）；文件名记为 `registry_key`；补扫 `~/Applications`、`~/AppImages` 下的 `*.AppImage`。
- **macOS**：`/Applications`、`~/Applications` 下 `*.app/Contents/Info.plist`（XML 直接解析，二进制 plist 经 `plutil` 转换），`CFBundleIdentifier` 记为 `registry_key`。

### 2.2 阶段 2：预过滤与倒排索引（`CatalogMatchIndex`）

- `match_unmanaged` 先剔除已纳管条目（`canonical_lookup_id` 归一）与 `platforms` 不含当前平台的条目，再建索引、打分、做磁盘与 PE 探测。
- 收录项每次扫描预归一化一次，建四路倒排桶：名称词元（名称、repo、简短英文标题、安全别名）、主程序词干（精校标识、repo、各平台包标识）、安装目录段（`install_dirs`、repo）、发布者词元（owner、`publishers`）。每个本机条目只对召回的候选打分。
- `is_installer_asset_identifier` 识别发布页安装包/压缩包资产名（`setup`/`installer`、内嵌版本号、架构与打包词元、`.paf.exe`/`.msi`/`.zip`/`.7z`；应用自身 repo 或名称已含的词除外）；这类标识不参与匹配与寻址，`ScanConfig` 在精校标识之后恒追加 repo/名称派生候选。种子测试保证 `catalog.json` 的 Windows 标识不含此类资产名。

### 2.3 阶段 3：边界安全打分与一对一指派（`matcher.rs`）

本机显示名先经 `normalize_app_title` 去掉尾随版本号、架构词与 `(x64)`、`(User)`、`(x64 zh-CN)` 等标注；名称按整词元比较，路径按路径段比较，不做裸子串匹配。

| 信号 | 分值 | 依据编码 |
|---|---|---|
| 精校主程序或应用包标识精确命中（通用文件名如 `code.exe` 及 repo 派生主程序只记弱分） | 0.48 / 0.30 | `executable` / `bundle_id` |
| 名称精确相等（名称、repo、简短英文标题、`registry_key`；名称首词是本条目所有者或登记发布者时另比较去掉该前缀的名称） | 0.55；不足 4 字符（CJK 不足 2 字）的短名 0.38 | `exact_name` |
| 整词元前缀 / 中段完整词元序列 | 0.42 / 0.32 | `prefix_name` |
| 安全别名精确相等 | 0.38 | `alias` |
| 安装目录段命中（主程序已命中时为叠加分） | 0.22 / 0.10 | `install_dir` |
| 发布者与 owner 或 `publishers` 一致（去组织后缀噪声词） | 0.22 | `publisher` |
| 非占位版本号与收录版本一致，且已有名称或主程序证据 | 0.05 | `version` |

- **安全别名**：剔除闭源竞品名、品类泛词、其他收录项的名称/repo、含「替代」/`alternative` 的词与过短词。
- **衍生版守卫**：收录项名称/repo 带变体词（`zstd`、`rev`、`next`、`nyanpasu`、`codium`、`ng` 等），而本机名称、包标识与路径里都没有时扣 0.35；此时主程序名与发布者视为与上游共用、不计分，除非安装目录段或包标识佐证。
- 及格线 0.45，中置信度 0.55，高置信度 0.70。全部合格候选对按（分数，精校主程序命中，名称精确，名称长度）降序贪心一对一指派，结果与收录库顺序无关；`AppMatchResult.match_reasons` 记录依据编码。

### 2.4 阶段 4：落盘核验与确认

- **路径**：`clean_display_icon` 依次剥引号外 `,N`、去引号、剥引号内 `,N`；DisplayIcon 为 `.lnk` 时解出目标主程序。`.lnk` 解析读 `LocalBasePathUnicode`、按系统代码页解码 ANSI 路径、解析 StringData 相对路径，最后按 UTF-16 与 ASCII 启发式扫描。
- **主程序选择**：缓存目录按路径段判定；卸载器、安装器、`Update.exe`、`crashpad_handler.exe` 等辅助二进制按文件名排除，显式声明为主程序的除外（`Bulk-Crap-Uninstaller.exe`）；Squirrel `app-<ver>` 取最新版本目录；根目录多个 `.exe` 时只认文件名与配置词元一致的那个。
- **导入路径**：已解析主程序存在即用；本机条目的安装目录仍存在则保留；两者都不在才全盘修复。
- **版本**：`is_version_newer` 把无后缀的两段纯数字版本补为三段，再与 PE 版本资源比较。
- **「我的应用」**：`get_installed_apps` 复用本轮已枚举的注册表条目回填 `installed_at`，不按应用逐个重扫注册表。
- **确认弹窗**：只默认勾选 `high`；`medium` 单色中性，`low` 用状态警示色并提示核对路径；本机名称与收录名不同时显示本机原名与发布者，并显示至多三条依据标签。

## 3. 取舍

- 衍生版与上游同名同主程序时，只能靠安装目录或包标识区分，因此需要在 `catalog.json` 为这类条目登记准确的 `install_dirs`（如 `7-Zip-Zstandard`、`Clash Verge`）；未登记时宁可漏配，不误配。
- 精校主程序命中可单独过线（0.48，低置信度），用于本地化显示名（`思源笔记`）；默认不勾选，交给用户核对。
- 开始菜单补扫会读取快捷方式目标的 PE 版本，`get_installed_apps` 首次需要注册表条目时一并承担这部分开销。

## 4. 验证

`src-tauri/src/scanner/matcher_eval_tests.rs` 在真实 `catalog.json` 上锁定三条基准：常见非收录软件（Miniconda、WPS、Visual Studio、Factorio、Twitch、AnyDesk、1Password、Postman、Firefox、Docker Desktop、官方 7-Zip 等）零误报；带版本号、作用域标注、Squirrel 目录与中文名的真实安装形态全部召回且 VS Code/VSCodium、Notepad++/Notepad Next 并存不串；400 条注册表快照对全库匹配结果稳定且在 100ms 内完成。
