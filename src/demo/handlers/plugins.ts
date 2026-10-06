import {
  demoListeners,
  demoUnregisterListener,
  emitDemoEvent,
} from '../demoState';
import { argStr, type InvokeArgs } from './common';

export function handlePluginCommand(cmd: string, a: InvokeArgs): { handled: boolean; result: unknown } {
  // 事件插件通道（listen/emit/unlisten）——支撑所有 on* 订阅的基础设施。
  if (cmd === 'plugin:event|listen') {
    const event = argStr(a, 'event');
    const handler = a['handler'];
    if (typeof handler === 'number' && event) {
      const list = demoListeners.get(event) ?? [];
      list.push(handler);
      demoListeners.set(event, list);
      return { handled: true, result: handler };
    }
    return { handled: true, result: 0 };
  }
  if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
    const event = argStr(a, 'event');
    if (event) emitDemoEvent(event, a['payload']);
    return { handled: true, result: null };
  }
  if (cmd === 'plugin:event|unlisten') {
    const event = argStr(a, 'event');
    const id = a['eventId'] ?? a['event_id'];
    if (event && typeof id === 'number') demoUnregisterListener(event, id);
    return { handled: true, result: null };
  }

  // 仅限桌面端插件的静默空操作存根（log/updater/window/webview/app/dialog）。
  if (cmd.startsWith('plugin:log|')) {
    return { handled: true, result: null };
  }
  if (cmd === 'plugin:updater|check') {
    return { handled: true, result: null }; // Demo 客户端始终视为“最新版本”
  }
  if (cmd.startsWith('plugin:window|')) {
    if (cmd.includes('is_maximized')) return { handled: true, result: false };
    if (cmd.includes('is_visible') || cmd.includes('is_focused')) return { handled: true, result: true };
    return { handled: true, result: null };
  }
  if (
    cmd.startsWith('plugin:webview|') ||
    cmd.startsWith('plugin:app|') ||
    cmd.startsWith('plugin:dialog|') ||
    cmd.startsWith('plugin:process|') ||
    cmd.startsWith('plugin:resources|') ||
    cmd.startsWith('plugin:opener|')
  ) {
    if (cmd === 'plugin:app|version' || cmd === 'plugin:app|get_version') return { handled: true, result: '0.5.0-demo' };
    if (cmd === 'plugin:app|name' || cmd === 'plugin:app|get_name') return { handled: true, result: 'Z-Store Demo' };
    return { handled: true, result: null };
  }

  return { handled: false, result: null };
}
