# Issue 12: config.toml 候选路径与默认值漂移、静默回退

Status: resolved
Priority: P2（配置正确性）
来源: 2026-10-21 全项目审查 · Rust 架构分片

## 描述

`src-tauri/src/config.rs:564-583`：

1. 外部 `config.toml` 候选路径含 CWD 相对路径，工作目录不同则读到不同配置；
2. 部分字段缺失时落 serde 派生默认值而非编译期嵌入兜底值——两套默认值存在漂移面；
3. 解析失败静默回退嵌入配置，无 warn 日志，排查困难。

## 修复方向

- 候选路径改为绝对化（可执行文件目录 / 用户配置目录），去掉 CWD 依赖。
- 用 `#[serde(default = "…")]` 逐字段指向与嵌入兜底同源的默认函数，单一事实源。
- 解析失败/文件缺失经 `z_log` 记 warn（含候选路径与错误），保持行为不变只补可观测。

## Comments

- 2026-10-21 已修复（commit 08e2402）：
  1. **候选路径绝对化**：改为 exe 目录 `config.toml`（安装目录随包覆盖）→ 用户配置
     目录 `resolve_default_app_data_dir()/config.toml`，全部绝对路径，CWD 不再影响
     读到的配置；原 CWD 相对候选（`config.toml`、`src-tauri/config.toml`）移除。
     首个存在文件生效的语义不变；外部配置加载成功/失败/缺席均记日志（log 管道经
     z_log 插件落盘）。
  2. **默认值单一事实源**：逐字段核对确认全部 serde 字段已指向与 `Default` 实现同源
     的默认函数；新增 `serde_field_defaults_match_embedded_baseline` 逐项相等测试锁
     「默认函数 == 嵌入 toml 字面量」。**测试立即抓到真实漂移**：
     `default_oauth_client_id` 返回空串而嵌入 toml 是真实 ID（外部文件缺 `[oauth]`
     段会落空值导致 Device Flow 无法发起），已修正为与嵌入同值并注明锁测试。
     `strict_errors` 为文档化的按构建类型回退语义（`cfg!(debug_assertions)`），刻意
     不与文件字面量同源，测试中单独断言。
  3. **可观测性**：嵌入 config.toml 解析失败、外部文件读取/解析失败、无任何外部文件
     加载三条路径均记 warn（含候选路径与错误），行为不变（仍回退嵌入配置）。
  4. 为逐项断言给 8 个节结构体补 `PartialEq` 派生（纯 derive，无行为影响）。
  5. 验证：`cargo test` 351 过（新增 2 测试：锁值 + 候选绝对性）/ `clippy -D warnings`
     干净。与 38 号工单同改 config.rs，按工单顺序执行避免自我冲突。
