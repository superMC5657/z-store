# Issue 18: useAppSettings 持久化：无 catch / 不回读 / TTL 挡位 0 被吞

Status: resolved
Priority: P2（前端正确性）
来源: 2026-10-21 全项目审查 · 前端核心 + services 分片

## 描述

`src/useAppSettings.ts` 三处：

1. `:120-122`：`handleUpdateSetting` 乐观 set 后 `await saveSetting` 无 catch——持久化
   失败即 unhandled rejection，UI/DB 分叉且无提示。
2. 同处：成功后不回读后端归一化钳制值（后端对挡位 `[0,10,60,360,1440]` 归一，非法回退
   60），前端展示值可能与落库值不一致。
3. `:35`：`Number(v) || DEFAULT` 把合法挡位 `detail_cache_ttl_minutes='0'`（实时校验档）
   吞成默认 60，与后端 `db/mod.rs:33` 归一口径冲突。
4. `:70`：`switchMirror` 同为 fire-and-forget。

## 修复方向

- `handleUpdateSetting`/`switchMirror` 补 try/catch：失败 toast + 回滚乐观值；成功后用
  后端返回/归一化结果回写 state。
- `:35` 改显式判空（`v === '' || v == null ? DEFAULT : Number(v)`），保留 `0` 挡位。

## Comments

- `'0'` 挡位按嘱保留：`:35` 改显式判空 + `Number.isFinite` 防护（`v === '' || v == null ||
  !Number.isFinite(n)` 才回默认），`'0'` 直通为 `0`，垃圾串（NaN）仍回默认，旧垃圾值防护
  不回退。
- 归一回写取「前端镜像」而非 IPC 回读：`save_setting` 只回 `bool`（不回归一值），
  逐次 `get_settings` 回读多一次全量 IPC 且会触发镜像副作用面；故在 hook 内按后端
  `normalize_setting_value` 同口径镜像（`DETAIL_CACHE_TTL_VALID_MINUTES = [0,10,60,360,1440]`
  与 `watch_notify_frequency` 两键——AppSettings 实际持有且后端会归一的仅此两键，
  asset_cache_*/strict_errors 不在此 hook 面）。镜像漂移风险由两端注释互指约束。
  注意 TTL 非法回退值前端取 `DEFAULT_SETTINGS.detail_cache_ttl_minutes`（60），后端取
  config.toml（常态同为 60）；若 config.toml 改默认，启动快照（get_settings 权威）仍会
  纠正展示值。
- `handleUpdateSetting`：try/catch 包 `saveSetting`，失败回滚乐观值（回写闭包内旧值）+
  `notifyToast` error（新 i18n 键 `settings.persist_failed`），不再 unhandled rejection；
  成功且归一值 ≠ 乐观值时回写 state。
- `switchMirror` 启动回放：`.then(ok=>...)`/`.catch` 双路失败均回滚 `active_mirror='direct'`
  （后端镜像初始态即 direct，fail-closed 保持直连，见 `mirror.rs` `MirrorManager::new`）+
  warning toast（新键 `settings.mirror_replay_failed`，被拒分支带
  `settings.mirror_replay_rejected` 理由）。启动不被打断的语义保留（异步 toast，非阻塞）。
- 顺手修掉分支上 `pnpm build`（tsc）存量拦路：#08 删除 `get_host_tokens` 时
  `demo/tauri-mock.ts` 残留 import 未清（无引用纯删一行，独立 commit ba6446a）。
- 测试：`src/useAppSettings.test.tsx` 9 用例（`'0'` 保留 / NaN 防护 / 合法 0 透传 /
  非法 30→60、hourly→daily 归一回写 / 失败回滚+error toast / 镜像回放 false·reject·成功
  三态）。该文件 9/9 通过；`tsc --noEmit` 干净。
