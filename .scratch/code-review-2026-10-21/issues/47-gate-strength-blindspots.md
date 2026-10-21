# Issue 47: 质量门禁盲区（CMD 相等/覆盖率入 CI/双端常量/invoke 封禁/嵌入 TOML 段锁）

Status: resolved
Priority: P3（质量基建）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · 测试与工具链分片

## 描述

36/34/28/38 号的门禁存在「断言强度不足」的共性：

- `cmdAlignment.test.ts` 只断言 `CMD ⊆ 注册集`（死命令不可见），注释写「后端当前注册 96 条」，
  实测两侧均 94。
- `vitest.config.ts` 有 coverage 块无 `thresholds`，CI 跑 `pnpm run test`（不带 coverage），
  覆盖率数字从未进 CI。
- `DEFAULT_ICON_BG` 在 TS 与 Rust 各一份字面量，只有前端侧被 `mappers.test.ts` 钉住。
- `noDirectInvoke` 的扫描面巡不到 services 内的裸 `invoke`（`appProcess.ts` 实际已旁路）。
- `serde_field_defaults_match_embedded_baseline` 在「删段 → 回退默认」这一漂移模式下恒绿。

## 修复方向

- CMD 改集合相等并报对称差；覆盖率阈值设定并接入 CI；常量加双端断言；
  invoke 封禁扩面到全域；嵌入配置补结构存在性锁。

## Comments

- `cmdAlignment.test.ts`：集合相等 + `{missing, dead}` 对称差输出，计数改实测 94。
- `vitest.config.ts`：thresholds statements 74 / branches 71 / functions 67 / lines 74
  （实测 77.64 / 74.70 / 70.58 / 77.64）；`ci.yml` Linux 腿 `pnpm run test:coverage`，
  Windows 腿保持 `pnpm run test`。
- 新增 `src/styles/tokens.parity.test.ts`：解析 `src-tauri/src/github/http.rs` 的
  `DEFAULT_ICON_BG` 与 TS token 逐字相等（双端任一侧漂移即红）。
- `noDirectInvoke.test.ts`：扫描面扩到整个 `src/`，豁免仅 `services/api/client.ts`，
  裸 `invoke(` 与 `@tauri-apps/api/core` 一并拦，含合成用例证明三种形态都命中。
- `config.rs` 新增 `embedded_config_toml_declares_every_section`：7 段存在 + license 名单 37 条
  + enabled 布尔，删段即红。
- 验证：`vitest` 894 过（新增 2 例 parity）、`cargo test` 378 过、`clippy -D warnings` 绿。
- 提交：0e2cf0f（config 段锁 57ef4f4）。
