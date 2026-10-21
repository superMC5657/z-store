/**
 * 客户端进程控制唯一出口。
 *
 * 豁免说明（可见 allowlist）：`plugin:process|restart` 为官方插件命令，**有意**
 * 不进 CMD 表——CMD 仅收本仓后端命令（cmdAlignment 门禁按 lib.rs 注册集对齐，
 * 插件命令不在其中）；同时视图/组件层禁直调（noDirectInvoke 卡点），插件命令的
 * 合法出口即本封装。当前构建未引入 plugin-process 依赖时 invoke 会 reject，
 * 由调用方提示手动重启（ClientUpdateRow 手动重启兜底）。
 */
export async function restartApp(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('plugin:process|restart');
}
