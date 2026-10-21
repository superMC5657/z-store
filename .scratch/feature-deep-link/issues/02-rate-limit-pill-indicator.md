# Issue 02: 实时 API 速率限制指示器与配额告警

Status: resolved

## 描述

在用户界面顶栏提供全局可见的 API 速率配额感知状态指示器：
1. 状态指示器交互设计：
   - 在 `TitleBar.tsx` 右侧（最小化/最大化控制区左侧）嵌入 Fluent 2.0 亚克力药丸胶囊 `RateLimitPill`；
   - 根据当前配额动态变色：
     - 绿色：剩余配额 > 100（充裕）；
     - 黄色：剩余配额 <= 100（吃紧，提示配置 Token）；
     - 红色：剩余配额 0 或网络阻断；
2. 交互联动：
   - 鼠标悬浮展示 Popover，列出 GitHub 与 Codeberg 各自主机的实时剩余配额与重置时间倒计时；
   - 点击药丸胶囊直接触发导航至设置中心（`SettingsView.tsx`）的「🌐 多代码托管平台与 API 令牌管理」面板；
3. 后端主动同步：
   - 在每次调用 GitHub / Gitea API 成功后自动更新缓存配额并可通过 IPC 获取最新状态。

## Comments

- 提升用户对公共 IP 限流与个人 Token 优势的直观认知。

## Answer

> 已被 `../spec.md` 校准注记取代（以代码为准）：主界面无 `RateLimitPill` 胶囊，仅账号卡片按需管理，保留 `quota-updated` 监听；以下为原方案存档。

已实现顶栏实时 API 速率配额感知胶囊与设置联动：
1. `TitleBar.tsx` 右侧嵌入 Fluent 2.0 亚克力药丸胶囊（`🟢 API 4980/5000` / `🟡 API 12/60` / `🔴 API 耗尽`）；
2. 悬浮展开半透明亚克力 Popover 提示卡片，展示 GitHub 配额健康度及 Token 状态；
3. 点击胶囊一键直达设置中心的多源 Token 管理面板；
4. 定时轮询与启动拉取，状态实时同步。

