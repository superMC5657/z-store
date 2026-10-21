# 04: 超大仓库探测有界不爆内存

**What to build:** 趋势榜与搜索后台补探遇到超大单体仓库时，前端表现为徽章/裸行而非卡死，后台内存有界。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] 无长度声明的大目录响应超限即中断，不全量缓冲
- [x] 中断后该行保持可展示状态（徽章或裸行），不影响同批其他行

## Answer

根因：统一图标补探 `IconFetch` 慢路径 `probe_trees`（`src-tauri/src/github/icon_probe.rs`）目录体读取用 `resp.bytes().await` 全量缓冲后才判 2MB 上限。无 `content-length` 声明的 chunked 大目录响应跳过层1预检，直接把整个体载入内存再 bail，超大单体仓库即无界缓冲爆内存；`trees_timeout` 仅覆盖 `send()` 头阶段，体阶段无界。

改动（只碰 04 范围，前端零改动，未动 01 的 `compareIconPriority` 语义与 02 的 `pinned` + `merge_detail_icon` 语义、不碰 03/05 范围）：
- `src-tauri/src/github/icon_probe.rs`：`MAX_TREE_BYTES`（2MB）/`MAX_TREE_NODES`（2万）由 `probe_trees` 内常量提升为模块级 `pub(crate)` 常量；新增纯决策 `tree_body_within_cap(accumulated, next_chunk, cap)`（超限即 false）与有界流式读取 `read_bounded_tree_bytes(resp, cap)`（经 `bytes_stream` 逐块累积、超限即中断返 `None` 并 drop 流，不全量缓冲）；`probe_trees` 层2改调该函数（层1 `content-length` 预检与层3节点数上限不变）。中断返 `None` 经 `probe_single_live` 逐 job 吞掉、`fetch_icons_stream` 该 job 不 `emit`，该行保持首屏徽章/裸行，同批其他 job 经 `buffer_unordered(pool=5)` 隔离继续、有界并发 D6 不变。
- 同文件 `#[cfg(test)]`：新增 `test_tree_body_caps_are_bounded`（阈值锁定）与 `test_tree_body_within_cap_stops_at_limit`（边界 + chunked 三块模拟第三块中断）。

验证：
- `cargo test --manifest-path src-tauri/Cargo.toml icon_probe`：6 项全过（含新增 2 项）。
- `cargo test --manifest-path src-tauri/Cargo.toml icon_fetch`：6 项全过（统一图标补探 `IconFetch` 无回归）。
- `cargo test --manifest-path src-tauri/Cargo.toml`：249 passed、0 failed、3 ignored。
- `npx tsc --noEmit`：通过（后端-only，无前端改动）。
- `npx vitest run src/services/iconStore.deepen.test.ts src/services/iconStore.l5badge.test.ts src/views/HomeView.search-icon.test.tsx`：20 项全过（01 语义无回归）。
