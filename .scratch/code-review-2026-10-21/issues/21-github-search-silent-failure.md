# Issue 21: 在线搜索失败伪装空结果、license 兜底 "FLOSS" 失真

Status: resolved
Priority: P3（正确性）
来源: 2026-10-21 全项目审查 · Rust 架构分片

## 描述

1. `src-tauri/src/github/search.rs:196,138`：在线搜索 JSON 解析失败/非 200 一律
   `Ok(vec![])`——瞬时网络故障被伪装成"无结果"，用户与上层无法区分。
2. `src-tauri/src/github/search.rs:275` 与 `detail_fetch.rs:433`：未知 license 兜底为
   "FLOSS"——把"未知"标成"已验证开源"，与 D1 语义失真。
3. `src-tauri/src/github/developer_endpoints.rs:4`：开发者仓库列表固定 30 条无分页
   （有 Star 探测 20 条预算护栏，预算内无恙，但列表展示会截断）。

## 修复方向

- 搜索失败上浮错误态（区分 空结果 / 网络失败），前端已有 loading/error/retry 三态模式
  可接。
- 未知 license 用显式 `unknown` 值，D1 门禁按未知=不放行处理（对齐 ADR-0018 默认开）。
- 开发者端点补 Link header 分页或标注截断。

## Comments

- **搜索失败上浮**（`src-tauri/src/github/search.rs#search_github_online`）：网络
  send 失败 → `Err(GitHub 搜索网络失败…)`、非 2xx → `Err(HTTP nnn)`、JSON 解析
  失败 → `Err(解析…失败)`，三分支不再汇入 `Ok(vec![])` 伪装无结果；命令层
  `.await?` 原样透传，前端 `useSearchState` catch 车道（`search.online_failed`
  「在线搜索暂不可用」）与成功空车道（「未找到相关在线应用」）天然区分，零前端
  改动接入。`owner/repo` 直查失败回退搜索的既有分流不变（搜索侧失败才上浮）。
  注：搜索 URL 硬编码 api.github.com 无 api_base 覆写缝，无 mock 单测，行为由
  代码形态 + 前端车道锁定。
- **license 显式 unknown**：`fetch_online_repo`（search.rs）与
  `resolve_detail_stats`（detail_fetch.rs）兜底由 `"FLOSS"` 改 `"unknown"`，并补
  空串过滤（`filter(!trim.is_empty)`，与同函数 homepage 兜底同模式——修复中
  发现收录库空 license 串会顶掉兜底产出 `""`）。D1 门禁按名单外拒绝
  （`UNKNOWN` 不在 DEFAULT_LICENSE_ALLOWLIST，normalize 后大写比对），与
  `Unknown`/`NOASSERTION` 同拒，ADR-0018 默认开语义不变；前端 `{app.license}`
  直渲染无特判，`unknown` 直出。
- **开发者列表截断标注**（二选一取标注，不动配额敏感请求面）：`DeveloperProfile`
  增 `repos_truncated`（serde default 兼容旧载荷），`fetch_developer_profile_with_cache`
  按 `public_repos > repos.len()` 判定（public_repos=0 归一为行数，离线兜底分支
  天然不误标）；前端 `DeveloperProfile` 类型加可选字段，模态框「开源项目矩阵」
  标题旁明示「仅展示最近更新的前 N 个」。Link header 分页未取：`get_with_etag`
  不透出 Link 头，扩共享 SSOT 牵连面大，且翻页倍增请求与本模块配额护栏哲学相悖。
- **测试**：`resolve_detail_stats` 5 态锁值（双空/repo空/收录空/收录MIT/repoMIT）；
  developer_profile 截断 mock 双例（5>1 标注、1=1 不误标）；门禁坏值名单补
  `unknown`/`FLOSS`。cargo test 362 全绿 + clippy -D warnings 干净；vitest 749 全绿。
