# Feature D: 开发者全景、动态流与 Starred 同步 (Feature Specification)

## 1. 目标与背景

借鉴 Komi Store 的深层开源生态连接与社交发现维度，在 Z-Store 中拓展开发者主页聚合展示、个人 GitHub Starred 仓库自动发现/同步，以及本地浏览与搜索历史持久化能力。

## 2. 核心架构与功能模块

1. **开发者全景数据服务 (`developer-profile-api`)**
   - 支持解析 GitHub 开发者/组织公开资料（头像、Bio、关注者、公开仓库数量、主页网址等）；
   - 拉取该开发者名下所有开源仓库，智能标识在 Z-Store 精选收录库中的收录状态与构建产物情况；
   - 联动 ETag 缓存，提供 Tauri IPC 命令 `get_developer_profile(developer: String)`。

2. **前端沉浸式开发者主页弹窗 (`developer-profile-view`)**
   - 在应用详情页（`AppDetailModal`）等处支持点击开发者/组织标识唤起 `DeveloperProfileModal`；
   - 遵循 Fluent 2.0 亚克力毛玻璃视觉规范，展示开发者头部 Banner、名下开源矩阵网格；
   - 支持一键安装/打开详情，以及快速跳转 GitHub 网页主页。

3. **GitHub Starred 仓库同步与过滤引擎 (`github-stars-sync`)**
   - 支持用户输入 GitHub 用户名或基于已配置的 PAT，自动拉取其 Starred 仓库列表；
   - 过滤与匹配：交叉比对收录库或检索仓库 Releases，筛选出具备可执行文件的开源软件；
   - 在「我的收藏」中新增「🌟 GitHub Star 同步」视图，支持一键批量装机与收藏。

4. **搜索与浏览历史本地持久化 (`recently-viewed-history`)**
   - SQLite 新增 `search_history` 与 `view_history` 表；
   - 搜索框聚焦时弹出最近搜索历史词条，支持点击快速回填与清理；
   - 记录最近浏览过的软件（滑动窗口限额去重），在首页提供“🕒 最近浏览”便捷通道。

> 范围外已实现注记：远端 trends（OSSInsight → HN → 本地降级，`services/trends.ts:80-88,231-261`，经 `browserLockdown.ts:223` openUrl 管控）已落地，本特性不重复覆盖。
