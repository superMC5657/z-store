# 02: 本地库数据口径（提交后仍在库）

**What to build:** 把「库内成员」从「collected 系」扩为「collected 系 + submitted」，让提交 Issue 只增加上游进度，不撤销本地可搜可装与黄标。门禁保持原样：submitted 不可重收录、不可提交 Issue、不可退回草稿。

**Status:** resolved

- [x] Rust：`is_local_library_status`；`list_local_library_apps/items`（含 submitted）；`get_collected_custom_item` 与 `collected_overlay_items` 改库内谓词
- [x] Rust：门禁不动（`mark_submitted` / `mark_collected` / `revert` / `ensure_collected_for_pr` 仍拒/限 submitted）
- [x] TS：`isLocalLibraryStatus`；`App.tsx` 改吃库内摘要（`localLibrarySummaries`）；`VerifiedBadge` 兜底改库内谓词；合并目录补位行携带 status
- [x] 测试：Rust 库内/门禁/归档/收藏回填；FE 合并/黄标/草稿不叠黄；全量门禁通过

**Blocked by:** 无

## Comments
- 2026-10-20：已实施。Rust：`is_local_library_status` + `list_local_library_apps/items` + 详情/安装回退与 overlay 同口径；门禁保持 `is_collected_status`。FE：`isLocalLibraryStatus`、`localLibrarySummaries`、徽标兜底、合并补位行携带 status。验证：Rust 325 通过（`cargo test`），FE 全量 723 通过。

