import { tauriInvokePlugin } from './api/client';

/**
 * 客户端进程控制唯一出口。
 *
 * `plugin:process|restart` 为官方插件命令，经 `tauriInvokePlugin` 透传：命令不在
 * `CMD` 表（表中仅本仓后端命令，cmdAlignment 按 lib.rs 注册集对齐），但出口仍守
 * `isTauri` 守卫与开发期请求键 camelCase 检查；视图/组件层禁直调（noDirectInvoke 卡点）。
 * 插件未引入时 invoke 照常 reject，由调用方提示手动重启（ClientUpdateRow 手动重启兜底）。
 */
export async function restartApp(): Promise<void> {
  await tauriInvokePlugin('plugin:process|restart');
}
