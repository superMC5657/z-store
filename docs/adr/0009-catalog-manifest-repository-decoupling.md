# ADR-0009: 应用市场生态清单仓库与客户端运行时引擎解耦

- **状态**: Accepted
- **日期**: 2026-09-10
- **决策者**: 架构团队与用户共同裁决

## 上下文

在 ADR-0007 中确立了应用市场由 `catalog.json` 唯一定义的原则，并配置了由 GitHub Actions 定时运行保鲜脚本。但在实际运作与演进中，单仓库单分支的维护模式显露出了以下痛点：
1. **Git 提交历史被机器人污染 (Git Log Pollution)**：每周自动保鲜产生的 `chore(catalog): automated refresh...` commit 不断混入客户端主分支，严重干扰了核心代码的演进轨迹与排查体验；
2. **代码引擎与生态内容耦合严重 (Code vs Content)**：`z-store` 是桌面客户端引擎（基于 Tauri 2 + Rust + React），而 `catalog.json` 是应用生态的内容数据。当外部社区开发者希望贡献并收录开源应用时，必须向客户端代码仓库提交 PR，增加了审查成本与心智负担；
3. **架构模式与国际主流解耦实践脱节**：主流开源包管理器（如 Homebrew、Scoop、Winget、F-Droid）均严格采用“客户端引擎”与“软件清单仓库”分立的工程架构。

## 决策

1. **确立独立生态数据仓库（`z-store-catalog`）**：
   - 建立独立的生态清单数据仓库（`superMC5657/z-store-catalog`）；
   - 生态仓库独立管理 `catalog.json`、保鲜定时任务 CI、PR 准入格式自动化校验流，以及社区贡献规范（`CONTRIBUTING.md`）；
   - 彻底将数据维度的变动从客户端核心代码仓库剥离。

2. **客户端离线秒开种子兜底（Offline Seed Fallback）**：
   - 客户端主仓库（`z-store`）根目录继续保留一份 `catalog.json`，在打包时作为离线种子预置入安装包；
   - 确保初次安装、弱网或断网用户启动应用时能够 0 延迟立即可见精选应用列表，无白屏与网络阻断风险；
   - 客户端提供 `pnpm sync:catalog`（`scripts/sync-catalog-seed.mjs`），以便维护者在发版打包前一键拉取远端数据更新本地种子。

3. **客户端同步源与配置对齐**：
   - `src-tauri/config.toml` 中 `default_source_url` 更新指向 `https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json`；
   - `src-tauri/src/config.rs` 中代码内置兜底地址同步对齐加速镜像前缀；
   - 客户端已实现的 ETag 条件协商增量同步机制无缝切换至该独立仓库。

4. **主客户端仓库 CI 净化**：
   - 彻底删除 `z-store` 仓库内的 `.github/workflows/refresh-catalog.yml`，主分支不再接受任何定时数据刷新的机器人提交；
   - 保持客户端代码历史 100% 纯净。
