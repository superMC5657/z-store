/** 待收录 Issue 预填流程：校验 https 链接、超长时复制后端载荷并打开预填页。 */
import type { TFunction } from 'i18next';
import { copyTextToClipboard } from '../../utils/appHelper';
import { tauriApi } from '../../services/api';
import type { ShowToast } from '../../types';

/** 编码后预填链接全长上限；超过时优先复制后端载荷文本，失败再退化为复制链接。 */
export const PREFILL_URL_LENGTH_LIMIT = 8000;

/** 轻提示通道（与 `PendingViewProps.onNotify` 同形）。 */
type Notify = ShowToast;

/** 原样复制后端载荷文本至剪贴板，provider 缺席或复制失败返回 false。 */
async function copyBackendPayload(load: () => Promise<string>): Promise<boolean> {
  try {
    const payload = await load();
    if (typeof payload !== 'string' || !payload.trim()) return false;
    return await copyTextToClipboard(payload);
  } catch {
    return false;
  }
}

/** 打开预填页失败时对真实 https 链接尝试复制并提示，非链接标识仅提示失败。 */
async function notifyPrefillOpenFailed(
  url: string,
  err: unknown,
  t: TFunction,
  notify: Notify,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const target = (url ?? '').trim();
  const copied = /^https:\/\//i.test(target) ? await copyTextToClipboard(target) : false;
  if (copied) {
    notify(
      t('pending.pr.open_failed_copied', {
        message,
      }),
      'error',
    );
    return;
  }
  notify(
    t('pending.pr.open_failed', { message }),
    'error',
  );
}

/** 预填流参数。 */
interface SubmitPrefillFlowArgs {
  /** 预填 URL 提供方（getCustomAppPrUrl）；缺席即预览模式硬拦。 */
  loadUrl: (() => Promise<string>) | undefined;
  /** 后端提交载荷提供方（超长时优先复制）；缺席退化为复制链接。 */
  loadPayload: (() => Promise<string>) | undefined;
  /** 非法 URL 提示里的目标标识（trim 后为空才用：单条传 id）。 */
  failLabel: string;
  /** 超长提示附加 i18n 参数（可选）。 */
  tooLongParams?: Record<string, unknown>;
  /** 预填页打开成功后的收尾（可选）。 */
  onOpened?: () => void;
}

/** 执行待收录预填提交流程：校验 https 链接、超长时复制后端载荷并打开浏览器预填页。 */
export async function runSubmitPrefillFlow(
  deps: { t: TFunction; notify: Notify },
  args: SubmitPrefillFlowArgs,
): Promise<void> {
  const { t, notify } = deps;
  // 先取 URL：后端门禁错直接透出 toast，中止不开页；无回调即预览模式不可提交。
  if (!args.loadUrl) {
    notify(
      t('pending.pr.preview_only'),
      'warning',
    );
    return;
  }
  let url = '';
  try {
    url = await args.loadUrl();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), 'error');
    return;
  }
  // 合法 https 预填必过：trim + 大小写不敏感判 https，避免首尾空白/大小写误杀；
  // 空值/非 https 仍 fail-closed（不尝试打开，直接失败感知）。
  const trimmedUrl = (url ?? '').trim();
  if (!trimmedUrl || !/^https:\/\//i.test(trimmedUrl)) {
    await notifyPrefillOpenFailed(trimmedUrl || args.failLabel, new Error('invalid prefill url'), t, notify);
    return;
  }
  url = trimmedUrl;
  // 按编码后链接全长判断是否超过阈值
  if (url.length > PREFILL_URL_LENGTH_LIMIT) {
    const payloadCopied = args.loadPayload ? await copyBackendPayload(args.loadPayload) : false;
    if (payloadCopied) {
      notify(
        t('pending.pr.payload_copied', {
          length: url.length,
        }),
        'success',
      );
    } else {
      notify(
        t('pending.pr.url_too_long', {
          length: url.length,
          ...(args.tooLongParams ?? {}),
        }),
        'warning',
      );
      if (await copyTextToClipboard(url)) {
        notify(
          t('pending.pr.url_copied_open_hint'),
          'info',
        );
      }
    }
  }
  try {
    await tauriApi.openUrl(url);
  } catch (e) {
    await notifyPrefillOpenFailed(url, e, t, notify);
    return;
  }
  args.onOpened?.();
}
