# Issue 02: 本地 Catalog 倒排索引与置信度打分算法

Status: resolved

## 描述

实现本地软件指纹与精选收录库（`catalog.json`）的启发式匹配引擎：
1. 建立加权评分算法 `score_match(scanned: &ScannedRawApp, catalog_entry: &CatalogItem) -> f32`：
   - 官方名称完全匹配：+0.45
   - 中文别名/拼音匹配：+0.35
   - 发布者/组织一致（如 VideoLAN, OBS Project, Microsoft）：+0.20
   - 主程序可执行文件名命中：+0.20
2. 置信度阈值过滤：
   - 得分 ≥ 0.70：标记为高置信度（推荐自动纳管）；
   - 0.50 ≤ 得分 < 0.70：标记为疑似候选；
   - 得分 < 0.50：舍弃不推荐。
3. 返回匹配候选集 `Vec<AppMatchResult>`，包含建议绑定的 GitHub 仓库坐标（`owner/repo`）及本地已安装版本。
4. 编写单元测试验证 VLC、OBS Studio、VS Code、7-Zip、Git 等主流开源应用的识别准确率。

## Comments

- `AppScanner::match_apps` 已在 `src-tauri/src/scanner.rs` 中完整实现并通过单元测试（`test_match_apps_high_confidence` 与 `test_match_apps_unrelated_filtered`）。
- `import_matched_apps` Tauri IPC 命令已在 `commands.rs` 中实现并写入 SQLite `installed_apps` 表。

