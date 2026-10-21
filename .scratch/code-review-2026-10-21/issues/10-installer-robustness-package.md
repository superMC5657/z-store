# Issue 10: 安装器健壮性加固包

Status: resolved
Priority: P2（健壮性）
来源: 2026-10-21 全项目审查 · Rust 安全分片

## 描述

一批独立小修，同属安装/卸载执行面，归并一单：

1. `executor_portable.rs:25-48/78-168`：zip/tar 解压无累计大小与条目数上限（zip 炸弹
   磁盘耗尽）。
2. `executor_uninstall.rs:223-237`：NSIS 临时卸载器文件被锁时 `while is_file_locked`
   无次数上限，安装任务永久挂起。
3. `executor_macos.rs:137-144`：`remove_dir_all` 吞错后仍 `cp -R` 到已存在目录，生成
   `X.app/X.app` 嵌套坏安装。
4. `executor_portable.rs:147-157`：tar 解压非可执行文件兜底 0o755，权限过宽。
5. `installer_uninstall.rs:65/150/161`：卸载清理 `let _ =` 吞错，删除失败仍报成功。
6. `downloader_http.rs:338`：Windows 先删后 rename，并发同名任务有竞争。
7. `commands/network.rs:202-218`：`fetch_trends_text` 先全量缓冲再查 2MB 上限，应流式
   截断（对照 CONTEXT.md D9 截断语义）。

## 修复方向

逐项：解压累计字节/条目上限（超限中止并清理）；锁等待加上限 + 超时报错；macOS 先确认
删除成功再复制；tar 按可执行位判 0o755/0o644；清理错误上浮到结果；rename 改
`rename` 失败重试或唯一临时名；trends 文本流式截断至 2MB。

## Comments

七小项逐项落地（合并一个 commit）：

1. **解压配额（zip/tar 炸弹）**：`executor_portable.rs` 新增 `MAX_EXTRACT_TOTAL_BYTES`
   （8 GiB）与 `MAX_EXTRACT_ENTRIES`（65536），`check_extract_quota` 纯函数统一判定；
   声明大小预检（提前拦超大声明）+ 实际写入复核（防声明谎报）双闸。超限回滚：仅删除
   本次解压新建的文件（`rollback_extracted` 跟踪清单），不动 app_dir 既有内容——更新
   安装场景旧版本保留，可重试。zip/tar 两通道同口径。
2. **NSIS 锁等待上限**：`executor_uninstall.rs` 临时卸载器锁轮询加 60s 上限，超时报错
   （含路径与手动处理指引），安装任务不再永久挂起。
3. **macOS DMG 删除确认**：`executor_macos.rs` 旧版本 `remove_dir_all` 失败即中止安装
   并报错（含权限/占用提示），删除后再确认 `dest_app` 不存在，杜绝吞错后 `cp -R`
   生成 `X.app/X.app` 嵌套坏安装。（macOS 门控代码，本机无法运行验证，保持最小改动。）
4. **tar 权限二值化**：有任一 exec 位 → 0o755，否则 0o644；不再把无 exec 位普通文件
   兜底成全员可执行，同时丢弃归档中的 setuid/setgid/sticky 特权位。
5. **清理错误上浮**：`cleanup_portable_path` 改返回 `Result<(), String>`，便携目录/
   单文件删除失败如实报错；默认便携缓存目录清理同样上浮。清理失败即卸载失败（DB 记录
   保留可重试），不再「删除失败仍报成功」。Desktop 死快捷方式清理保持 best-effort
   （#02 既有口径：宁留死链不越界删除）。
6. **下载落盘竞态**：`downloader_http.rs` 临时文件改唯一名（pid+纳秒后缀），防并发同名
   任务互写同一 `.tmp` 致字节交错成「各自哈希自洽、落盘混合」的损坏包；最终 rename 改
   「删+改」有界重试（5 次 × 100ms），化解 Windows 先删后改窗口内并发同名任务竞争，
   重试耗尽才报错并清理本次临时文件。
7. **trends 流式截断**：`fetch_trends_text` 弃「全量缓冲后判 2MB」，改 `bytes_stream`
   流式累计、超 2MB 即停止读取返回前 2MB（D9 截断语义；截断 body 的前端解析失败走既有
   兜底，无前端依赖 `upstream too large` 标记，已核实）。

**测试**：新增 4 个单测（配额纯函数含 u64 饱和、回滚只删跟踪文件、zip/tar 正常包解压
烟囱测试）；卸载安全测试随 `cleanup_portable_path` 签名更新断言。
**验证**：`cargo test` 347 通过；`cargo clippy -- -D warnings` 无来自本单触碰文件的告警；
本单无前端联动，vitest 全量另行跑过（见 07/11 单）。
