# 10: 加深轻量 release 拉取模块
**What to build:** 新建深 release-fetch 模块（缝合处：releases/latest ETag GET），两个 adapter：deep 详情（repo+README+校验清单+平台推导）与 shallow 轻量（tag+body，供流式更新检查+platforms-lite 共用）；删除 platforms-lite 内与 updates lightweight 逐字重复的 304/touch/save 回退分支；保持 ADR-0007 豁免语义（Streaming Update Check〈流式更新检查〉不走 Cache TTL），语义写入新模块注释。
**Blocked by:** 09（同 `github/http.rs`、`detail_fetch.rs` 先后错开）
**Status:** resolved
- [x] 更新检查走轻量路径结果与原来一致，README/仓库/checksum 开销消失
- [x] ETag 304（条件请求缓存）touch/save/回退单测经同一 interface
- [x] `cargo test` + `cargo clippy -- -D warnings` 通过

## Comments
- 2026-10-11：已实施并合入 dev-ics2（P2；cargo 201 通过含 12 个新单测、clippy 干净）。已知偏差：lite Failed 路径 precedence 归一化为 payload-before-row（仅离线双缓存并存时影响 `is_stale` 标记，代码内已注释）。
- 2026-10-11：票面对齐为 resolved（实现已合入 dev-ics2，见上条记录）。
