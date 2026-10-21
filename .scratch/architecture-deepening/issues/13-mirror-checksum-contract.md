# 13: 统一镜像改写与校验拉取→验证契约
**What to build:** 镜像改写收敛为单一 `rewrite(url)` interface（有状态安装下载与小文件 opportunistic 拉取为两种调用上下文，删除 checksum 第三份 `wrap` duplicate，`CatalogService` 经 adapter 注入改写后 URL）；SHA-256 校验收拢 fetch→verify 契约（manifest 拉取为 adapter，流式校验为 implementation，`Tampered` 销毁语义保留）；服务 ADR-0004，不重开。
**Blocked by:** 10（同 `detail_fetch.rs` 先后错开）
**Status:** resolved
- [x] 删除 `rewrite_checksum_url_with_fallback` 后校验拉取仍经直接/回退成功（删除测试）
- [x] `extract_checksums_map` 缺失时 `completed_unverified` 语义不变
- [x] 篡改包仍阻断并销毁临时文件；`cargo test` + clippy 干净

## Comments
- 2026-10-11：已实施并合入 dev-ics2（P3；cargo 205、clippy 干净，含删除回归三单测）。`installer_download.rs` 有状态双路径为合法双上下文、原样保留。
- 2026-10-11：票面对齐为 resolved（实现已合入 dev-ics2，见上条记录）。
