# Issue 07: 无 checksums 文件照常安装 + 自定义镜像任意主机

Status: resolved
Priority: P2（安全/供应链）
来源: 2026-10-21 全项目审查 · Rust 安全分片

## 描述

两个缺口互相叠加：

1. `src-tauri/src/commands/installer_install.rs:34-57`：上游无 checksums 时
   `completed_unverified` 文件照常进入 `execute_installation`，安装不阻断。下载侧标注
   诚实，执行侧无门禁——违背 CONTEXT.md D3「所有下载强制 SHA-256 比对，不符即阻断」。
2. `src-tauri/src/mirror.rs:85-91`：自定义镜像接受任意 `http://` 与任意主机（无 https
   强制、无白名单），配合上一条可被恶意镜像整体替换载荷。另 `mirror.rs:11-15`
   `is_github_domain` 子串匹配过宽（`notgithub.com`、`github.com.evil.com` 误命中）。

## 修复方向

- 按 D3 收紧：无校验清单的资产默认拒绝安装，仅在 UI 显式警示（"未校验"）+ 用户逐次
  确认后才放行，并在结果里保留 unverified 标记。
- 镜像：强制 https、主机白名单或至少域名校验；`is_github_domain` 改为解析 host 后
  精确匹配（含子域规则）。

## Comments

- **无校验资产默认拒绝（D3 执行侧门禁）**：`commands/installer_download.rs` 把
  `prepare_and_download_asset` 拆为 `select_download_asset`（详情+择取）与下载执行，
  安装通道在「择取」与「下载」之间插入门禁——无 checksums 资产在消耗带宽/落盘之前即被
  拒绝（`installer_install.rs`）。仅在 UI 显式警示且用户逐次确认（新命令参数
  `allowUnverified=true`）后放行；下载终态本就诚实保留 `completed_unverified` 标记，
  放行后不虚假声明已校验。仅下载（download-only）通道不受此门禁约束（其结果体自带
  `verified:false` 诚实标记，符合词汇表 Download-Only 语义）。
- **前端联动**：`install_app` 错误以机器可读标记 `unverified-asset-required:` 前缀返回，
  `useInstallState.handleInstallApp` 识别后挂起为待确认态（不弹错误、不 rethrow），
  `App.tsx` 复用 `InstallConfirmDialog` 出警示弹窗（「未校验资产」文案），确认后携
  `allowUnverified: true` 逐次重试；取消有 toast 反馈（新增 i18n key
  `toast.unverified_install_cancelled`）。更新中心两条路径未接确认弹窗：门禁生效即
  fail-closed，toast 展示拒绝理由（批量流内嵌逐项确认交互超出本单范围，安全方向不受影响）。
- **镜像收紧**：`mirror.rs` 新增 `validate_custom_proxy`——强制 https（明文 http 拒绝）、
  host 须为合法域名（标签字符/长度/连字符规则、TLD 含字母拒绝裸 IP、拒绝 userinfo 凭据）。
  `set_active_mirror` 准入失败拒绝切换保持现状（fail-closed，含启动回读历史存量值）；
  `switch_mirror` 命令前置校验把拒绝理由直达前端，`App.tsx`/`useAppSettings.ts` 补了
  catch；`test_proxy_latency` 与保存同一准入口径（允许测 http 却存不进去只会制造困惑）。
- **is_github_domain 精确化**：改为解析 host 后精确/子域匹配（`github.com`、
  `githubusercontent.com` 及其子域）；`notgithub.com`、`github.com.evil.com`、
  `mygithubusercontent.com`、无 scheme 裸串不再误命中。镜像改写与直连失败兜底共用该
  判定，行为同步收窄（`github-releases.githubusercontent.com` 经子域规则仍覆盖）。
- **测试**：mirror 新增 3 个单测（host 精确匹配、准入口径、http/非法 host 拒绝切换）；
  前端 vitest 全量通过（深链守卫测试断言随 installApp 新签名同步第 4 参）。
- **验证**：`cargo test` 347 通过；`cargo clippy -- -D warnings` 无来自本单触碰文件的
  告警（仓库基线另有 20 个预存 clippy 告警，属其他工单，未动）；`pnpm vitest run`
  733 通过；`tsc --noEmit` 干净。
