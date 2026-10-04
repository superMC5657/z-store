# ADR-0011: doforce 趋势聚合源例外（绕过 ForgeProvider 的 Rust 直取通道）

- 状态: Accepted
- 日期: 2026-10-04
- 关联: ADR-0006（多 Forge 生态支持）、ADR-0002（直连 API 与镜像管道）

## 背景

趋势榜单的 `rising` / `healthy` 两榜需要“周期增量”速度口径（各仓库在本周期内新增 star 数），
而各 Forge 官方 REST API 均不提供廉价可用的聚合增量字段；逐仓拉取事件时间线再聚合的配额与
延迟成本不可接受。同时 WebView 内 `fetch` 受 CORS 限制，无法直取第三方聚合源。

`https://trend.doforce.dpdns.org/repo` 为公开的趋势聚合 API（无需 key），单次返回全量快照，
条目自带 `change` 真实增量字段，恰好满足两榜“一次抓取、各自排序”的需求。

## 决策

1. **例外许可**：仅趋势数据层允许经 Rust 命令 `fetch_trends_text` 直取
   `trend.doforce.dpdns.org`，不经过 ADR-0006 的 `ForgeProvider` 抽象。
   该命令为 SSRF 收紧的专用通道：仅 `https`、三主源 host 白名单
  （`github.com`、`trend.doforce.dpdns.org`、`api.github.com`，见
   `src-tauri/src/commands/network.rs` 的 `TRENDS_TEXT_HOSTS`），10s 超时，
   错误串携带可机读标记（`upstream status {code}` / `request timeout` /
   `network error`），完整 URL 永不回显（query 不记日志）。
2. **一榜一源、无降级链**：`rising` 按 `change` 降序、`healthy` 按 `forks + change`
   代理分降序，共享同一次抓取（单飞 + 12h 共享缓存）；主源失败即按
   `error`/`empty` 契约返回，绝不回退本地加权假榜；429 恰好重试一次
  （`Retry-After`，上限 60s，超限直接 error）。
3. **不扩展例外**：应用发现、下载、更新链路仍严格走 `ForgeProvider`；
   任何新增直取 host 必须修订本 ADR 并同步更新 Rust 侧白名单与单测。

## 后果

- 正面：两榜增量口径真实（`change` 实测值，缺失即 `undefined` 不伪造），远端命中压到最低。
- 风险：第三方聚合源可用性不受控（`gittrend.io` 已有持续 429 后摘除的先例）；
  doforce 若失效，两榜如实展示错误面板 + 重试，不做静默 fallback。
- 信任边界：doforce 数据仅用于榜单展示，不进入安装/校验链，无凭据随行。
