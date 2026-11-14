# Issue 02: 中英双语分词器、目录级 IDF 词表与词边界分类推断模块

Status: resolved
Blocked by: none

## 背景

现行文本处理存在三处缺陷（见 `spec.md` §1、§3.1）：
1. 分词丢弃全部中文字符与双字母技术词（如 `ai`、`3d`、`ui`、`db`），使纯中文搜索历史 100% 丢失；且未剥离 URL、未拆分连字符，导致 `open-source`、`cross-platform`、`desktop`、`https` 霸榜。
2. 缺乏目录级逆文档频率（IDF），高频泛化词与高区分度领域词（如 `mpv`、`wireguard`、`epub`）等权。
3. `infer_categories_from_repo` 使用裸子串 `text.contains(kw)`，造成 `video→ide`、`client→cli`、`github→git`、`notebook→book` 大面积误判，且对任意有 `language` 的未匹配仓库盲目兜底 `("dev", 0.45)`。

本 Issue 在独立新模块 `src-tauri/src/github/affinity_text.rs` 中构建并完整单测新一代文本底座，不修改现有 `affinity.rs`，以便与 Issue 01 完全并行推进。

## 目标

1. 新建 `src-tauri/src/github/affinity_text.rs` 并在 `src-tauri/src/github/mod.rs` 声明 `pub mod affinity_text;`：
2. **双语分词函数 `pub fn extract_tokens(text: &str) -> Vec<String>`**：
   - 先过滤形如 `http://\S+`、`https://\S+` 的 URL 片段；
   - ASCII 词元：以非 ASCII 字母数字（保留词内 `+` 如 `c++`，但按 `-`、`/`、`.`、`_` 切分，使 `open-source` 拆为 `open` + `source` 被停用词拦截）切分小写词元；长度 `>= 3` 或命中双字符技术词白名单（`ai`, `ui`, `2d`, `3d`, `db`, `os`, `vm`, `go`, `qt`, `ip`, `ci`, `cd`, `md`, `tv`），过滤完整停用词表（在原表基础上补齐 `desktop`, `server`, `your`, `you`, `are`, `more`, `all`, `official`, `repository`, `supports`, `powerful`, `project`, `projects`, `github`, `gitlab`, `codeberg`, `code` 等高泛化虚词，注意保留有分类区分度的领域词）；
   - CJK 词元：对连续汉字序列（Unicode CJK Unified Ideographs `\u{4E00}..=\u{9FFF}`，字符数 `>= 2`）按滑动窗口提取双字 2-gram（如 `"远程桌面"` → `["远程", "程桌", "桌面"]`），过滤中文常见泛化停用双字词（`开源`, `软件`, `工具`, `应用`, `支持`, `平台`, `跨平`, `客户`, `户端`, `免费`, `一个`, `基于`, `管理`, `系统`, `器与`, `的跨` 等）；
   - 保持首次出现顺序去重。
3. **目录级逆文档频率 `pub struct CatalogIdf`**：
   - `CatalogIdf::from_catalog(items: &[CatalogItem]) -> Self`：对每条目录项拼接 `name + repo + description + description_en + aliases` 提取去重词元统计文档频次 `df(t)`；
   - `pub fn weight(&self, token: &str) -> f64`：当 `N == 0` 时返回 `1.0`；当词元在目录中未出现（`df == 0`，如用户搜的特定外部技术词）返回 `1.0`；否则返回 `(((n + 1.0) / (df + 1.0)).ln() / (n + 1.0).ln()).clamp(0.15, 1.0)`；
   - 提供辅助函数 `pub fn cosine_similarity(&self, a_tokens: &[String], b_tokens: &[String]) -> f64`，按 IDF 权重计算两词元集合的加权余弦相似度（范围 `[0.0, 1.0]`，任一为空返回 `0.0`）。
4. **词边界分类推断函数 `pub fn infer_categories(language: &str, description: &str, full_name: &str) -> Vec<(&'static str, f64)>`**：
   - 对输入提取小写 ASCII 整词集合 `word_set: HashSet<String>`（不去停用词或专用词元集，确保 `ide`/`cli`/`git`/`api`/`ssh`/`pdf`/`rss`/`svg`/`ocr`/`3d` 等短关键词可整词命中，同时 `"video"` 绝不命中 `"ide"`、`"client"` 绝不命中 `"cli"`、`"github"` 绝不命中 `"git"`、`"notebook"` 绝不命中 `"book"`）；
   - 多词英文短语（如 `"file manager"`, `"sing-box"`, `"remote desktop"`）与中文关键词仍在小写全文上匹配；
   - 保留高区分度领域编程语言辅助加成（`hcl/dockerfile/nix/shell/bash/powershell -> ops`，`shaderlab/glsl/hlsl/wgsl -> graphics`，`gdscript -> games`，`tex/typst -> office`），**彻底移除** `if matched.is_empty() && !lang.is_empty() { matched.push(("dev", 0.45)); }` 盲目兜底。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/affinity_text.rs`（新建）、`src-tauri/src/github/mod.rs`（仅挂载模块）。
- 禁止触碰：`src-tauri/src/github/affinity.rs`、`src-tauri/src/github/featured.rs`、`src-tauri/src/db/*`、`src/*`。

## 验收标准

- [ ] 单测：`extract_tokens` 对 `"An open-source cross-platform desktop app https://code.videolan.org/vlc"` 不产出 `open-source`、`cross-platform`、`desktop`、`https`；对 `"远程桌面视频播放器"` 产出有效中文双字词元（含 `"远程"`、`"桌面"`、`"视频"`、`"播放"`）；对 `"3d ai ui tool"` 产出 `["3d", "ai", "ui"]`。
- [ ] 单测：`CatalogIdf` 中高频词的 `weight` 严格低于罕见专有词（如 `mpv` > `editor`），空目录或未知词返回 `1.0`，`cosine_similarity` 对相同非空集合返回 `1.0`（±1e-9）、无交集返回 `0.0`。
- [ ] 单测：`infer_categories("C++", "Command line video client with https://github.com/a/b", "org/player")` 命中 `media` 且**不**误命中 `dev`（无 `video→ide`、`client→cli`、`github→git` 误判）。
- [ ] 单测：`infer_categories("Rust", "", "alice/my-experiment")` 返回空列表，不再盲目归入 `dev`。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 通过。
