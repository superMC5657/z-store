# ADR-0012：出站网络性能 P0（双池复用 + 有限并发 + 条件跳过）

- 状态：Accepted
- 日期：2026-10-05
- 关联：ADR-0002/0006/0011；首页策略锁死 balanced+7（用户确认不切换）

## 背景

Tauri 无服务端，全请求出站直调 GitHub/聚合源/CDN。已合并 cache 省流量波（ETag 收敛、HEAD/Range 首 32KB 验图、下载 hash-skip、目录异步落库、更新 ETag 探查并发）+ 本次省时间波。

## 决策

1. 复用：API/图标双池隔离单例（forge/http.rs:67-88），各 pool_max_idle_per_host=20、idle 90s、connect 5s；图标池 redirect limited(10)+浏览器 UA、恒禁 token。
2. 并发：仅三处 buffered 保序并发——目录 enrich 5、图标验图 3、starred 探测 4；单仓 10s 熔断，失败落 None。
3. 重试：仅 timeout/connect+429/5xx，最多 2 次、退避 200ms→800ms（github/http.rs:47）；401/404/304 直返。
4. 首包：图标先 HEAD 探类型/长度，再 Range 取首 32KB 验 magic（≥300B）；不支持者回退全量首块截断（icon_probe.rs:213/290）。
5. 跳过：详情/更新走 ETag 条件请求（304 零配额复用 payload），下载命中 hash 直接 skip，目录落库异步不挡首屏。
6. 趋势：fetch_trends_text 限长 2MB、10s 超时、三 host 白名单；429 仅按 Retry-After 重试一次（上限 60s）。

## 后果

- 正面：复用省握手 RTT，ETag/首包/跳过省流量配额，并发压首屏延迟。
- 风险：并发抬升限流概率；以 429 TRO（上报+单次重试+错误面板）对冲，不静默 fallback。

## 备选

- 单 Client 统一：被否，token 易泄漏到 CDN 域。
- 并发拉满：被否，触发限流得不偿失。
- 全链路熔断器：被否，杀鸡用牛刀，单仓超时+吞错已够。
- 全量 tree 改增量：暂缓，2MB 截断先止血。
