// 轻量应用内通知总线：新功能通过 window CustomEvent 发送 Toast 请求，
// 由 App 根组件统一渲染 ToastContainer。永远不抛异常、不阻塞主流程。
import { ToastMessage } from '../types';

export function notifyToast(text: string, type: ToastMessage['type'] = 'info'): void {
  try {
    window.dispatchEvent(new CustomEvent('zstore:toast', { detail: { text, type } }));
  } catch {
    // 忽略：通知失败不应影响业务流程
  }
}
