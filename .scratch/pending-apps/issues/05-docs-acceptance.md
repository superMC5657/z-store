# 05: 文档与全量验收（双轴模型落纸）

**What to build:** 把本轮定案写进仓库文档，避免下次再把「提交」当成离开本地库：ADR-0017 修订、CONTEXT 词汇表、pending SPEC 状态机。最后跑全量门禁。

**Status:** resolved

- [x] ADR-0017：补「库内归属 × 上游进度」两轴、`submitted` 仍在库、归档=同 id 权威切换（local→remote，单卡、黄转蓝）、标记为未提交语义
- [x] ADR-0017「已知边界」：远端未验证行归档后无来源标（不造第三徽标）；catalog 后续下架不回补本地
- [x] `CONTEXT.md`：新增「本地库 / 已提交」；写清 `isCollectedStatus`（可提交 Issue/可退回）与 `isLocalLibraryStatus`（在库）两个谓词的边界
- [x] `.scratch/pending-apps/SPEC.md` §3/§4：状态机、3 Tab + 分段、黄标覆盖面、归档展示
- [x] 门禁：`npx tsc --noEmit`、`npx vitest run`（723）、`cargo test`（325）/ `cargo test custom_apps` / `cargo test catalog_custom`
- [x] 记录 D3/D4/D5 的最终决定（保留归档页黄标、远端未验证无标、下架不回补）

**Blocked by:** 02, 03, 04

## Comments
- 2026-10-20：文档与门禁完成（ADR-0017 §2.7、CONTEXT 词汇表、SPEC §3/§4）。注意 `cargo test` 只接受一个 TESTNAME 过滤，双过滤需分两次跑或跑全量。
