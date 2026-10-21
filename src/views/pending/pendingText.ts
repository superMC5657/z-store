/**
 * 待收录页共用文案辅助：校验错误码取文案、轻提示通道签名。
 */
import type { TFunction } from 'i18next';
import type { ToastMessage } from '../../types';

/** 校验错误码 → 当前语言文案（缺键回退错误码本身）。 */
export function errorText(t: TFunction, code: string): string {
  return t(`pending.errors.${code}`, code);
}

/** 轻提示通道签名（TOAST 类型与 `ToastMessage.type` 同域）。 */
export type ShowToast = (message: string, type?: ToastMessage['type']) => void;
