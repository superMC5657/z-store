# 图标修复 Spec（草案，待选项确认）

> 来源：exp-1/exp-2/oracle 复核 F1-F4/M1-M7/m1-m9。术语以 `CONTEXT.md` 为准。
> 落盘：`.scratch/icon-fix/spec.md`。选项在 OpenChamber 选项卡页选择，本文件按推荐默认值起草。

## 0. 默认范围（Q1 推荐：仅 F1-F4）

- 必修：F1 前端 Level 单调反、F2 restore 无 TTL、F3 详情覆盖轮换、F4 trees 无界缓冲。
- 可选：M2/M4/M5/M6/M7 进第二批；M1 随 F3 联动；M3 配额双池需产品确认；m 级延期。

## 1. F 级策略（推荐默认）

- F1：新增 `compareIconPriority(a,b)`，数字越小优先级越高，替换 `iconStore.ts:775-777` 数值比较。
- F2：`restore_or_fetch_icon_cycle:226-241` 加 `is_icon_file_fresh + is_icon_fresh` 双检，过期走下载分支。
- F3：`app_icon_cycles` 加 `pinned` 标记；详情落库 `catalog_detail.rs:604-633` pinned 行只补 l-slot 不改 `level/selected_url`。
- F4：`icon_probe.rs:563-592` 改流式累积，超 2MB 即 bail，不用无界 `bytes()`。

## 2. M 级取舍（推荐第二批）

- M2 兜底按真 URL 为键；M4 翻页写 `assembledMore`；M5 probe 放宽无断言类型靠 sniff；M6 `save_and_emit` 先读旧行合并；M7 槽满不 seal 或复用 LRU。

## 3. 术语（domain-modeling 待确认）

- `Level` 纯 L1-L4 优先级；`Via=live|m2` 正交；`M1=前端内存/M2=DB落盘`；`selected_url` 与 `lN_url` 必须一致；`pinned=用户手动选择`。

## 4. 验收（推荐：cargo test + 前端单测）

- F1：先 L3 后 L2 用例；F2：过期文件不直接返回；F3：详情刷新不丢 pinned；F4：chunked 大 body 不 OOM。

## Comments

- 用户在选项卡页的选择快照粘回后，本文件按选择更新并转 issues/NN-*.md。
