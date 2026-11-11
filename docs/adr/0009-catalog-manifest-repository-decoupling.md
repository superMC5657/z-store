# ADR-0009: 独立生态清单仓库与客户端运行时引擎解耦

- **状态**: Accepted
- **日期**: 2026-09-10
- **决策者**: 架构团队与用户共同裁决

## 上下文

客户端应用引擎与社区应用生态数据（`catalog.json`）职责不同：
1. **职责边界清晰**：`z-store` 聚焦 Tauri 2 + Rust + React 客户端运行时引擎，`catalog.json` 则承载持续更新的开源应用列表与保鲜 CI，分仓维护可避免数据刷新提交干扰客户端代码演进轨迹。
2. **降低社区投稿门槛**：外部贡献者可直接向数据仓库提交 PR 收录应用与格式校验，与客户端工程发版周期解耦（类似 Homebrew、Scoop、Winget、F-Droid 的引擎/清单分立实践）。

## 决策

1. **独立生态数据仓库（`z-store-catalog`）**：
   - 使用独立生态清单数据仓库 `superMC5657/z-store-catalog`；
   - 生态仓库独立管理 `catalog.json`、保鲜定时任务 CI、PR 准入格式自动化校验流与社区贡献规范（`CONTRIBUTING.md`）。

2. **客户端离线种子兜底（Offline Seed Fallback）**：
   - 客户端仓库根目录维护随包打包的 `catalog.json` 离线种子；
   - 确保初次安装、弱网或断网启动时能够 0 延迟展示精选应用列表，无白屏阻塞。

3. **客户端同步源与配置对齐**：
   - `src-tauri/config.toml` 中 `default_source_url` 指向 `https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json`；
   - `src-tauri/src/config.rs` 内置兜底地址与 `config.toml` 同为该直连 URL（不带镜像前缀）；
   - 客户端以 ETag 条件协商对该独立仓库做增量同步。

4. **清单 CI 归属隔离**：
   - 清单数据校验与定期保鲜 CI 运行于 `z-store-catalog` 仓库。
