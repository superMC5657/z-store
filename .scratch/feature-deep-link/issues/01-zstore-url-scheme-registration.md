# Issue 01: 注册 zstore:// 系统协议与 Deep Link 路由分发

Status: resolved

## 描述

在操作系统层面注册并响应 `zstore://` URL Scheme，实现网页与外部应用直通 Z-Store：
1. 系统注册实现：
   - 在 Windows 上通过注册表（`HKCU\Software\Classes\zstore`）注册 URL Protocol，将可执行程序路径与命令参数关联；
   - 增加注册检测与主动注册命令 `register_deep_link_scheme() -> Result<bool, String>`；
2. 路由分发器 (`DeepLinkRouter`)：
   - 解析 URL 路径与参数：
     - `zstore://app/{app_id}` -> 打开详情弹窗；
     - `zstore://install/{app_id}` -> 唤起详情并请求安装；
     - `zstore://search?q={query}` -> 填入搜索框并搜索；
     - `zstore://developer/{owner}` -> 打开开发者全景主页；
3. Tauri IPC 与前端事件监听：
   - 提供 `handle_deep_link(url: String) -> Result<DeepLinkAction, String>` 命令；
   - 前端挂载深层链接监听器并执行对应页面跳转或弹窗唤起；
4. 编写单元测试验证 URL 语法解析与各种边界入参。

## Comments

- 保持与其他平台协议兼容设计。

## Answer

已完成系统协议注册与 Deep Link 路由分发机制：
1. 新建 `src-tauri/src/deeplink.rs`，定义了 `DeepLinkAction` 枚举（支持 app、install、search、developer、view）；
2. 实现了 `DeepLinkParser::parse` 与基于 Windows 注册表当前用户级（`HKCU\Software\Classes\zstore`）的协议注册器 `register_windows_protocol`；
3. 在 `commands.rs` 暴露 `register_deep_link_scheme` 与 `handle_deep_link` 并在 `lib.rs` 注册；
4. 单元测试 `deeplink::tests` 覆盖各种协议格式、查询串解码及非法入参拦截全部通过。

> 前端注记（以代码为准，`App.tsx:659-668,1089-1103,1310-1368`）：独立 `pendingDeepLinkInstall` 确认弹窗（非内联），先开详情再显式确认，绝不自动安装；SHA/资产文件名缺失时标未知（SHA 仅在有值时展示，来源缺省为“未知来源”，应用/仓库名缺失时回退显示原始 id）。

