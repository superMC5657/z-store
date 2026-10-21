/**
 * 待收录提交/预填共享流（单条与批量共用尾段）：
 * 「取 URL → https 门 → 超长复制后端载荷 → 打开预填页」单一实现，
 * 单条（handleSubmitPr）与批量（handleBatchSubmit）各自保留 gate→校验→忙态前段。
 */
import type { TFunction } from 'i18next';
import { copyTextToClipboard } from '../../services/api/catalog';
import { tauriApi } from '../../services/api';
import { resolveFallbackOpener } from '../../utils/browserLockdown';

/**
 * 预填 URL 长度门限（判定口径为编码后预填链接全长，含 percent-encoding 膨胀；
 * 与 Spec §5 对齐，阈值 8000）：
 * 超过即提示分批提交，单条/批量同口径；超长时优先复制后端产出的提交载荷
 * （前端不拼装 JSON），再照常尝试打开预填页；载荷不可得则退化为复制链接。
 */
export const PREFILL_URL_LENGTH_LIMIT = 8000;

/** 轻提示通道（与 PendingViewProps.onNotify 同形）。 */
type Notify = (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

/**
 * 预填页打开（先直调 `tauriApi.openUrl` 成功即返，失败才原生 `window.open` 兜底）：
 * - 直调覆盖后端 `open_url`（rundll32 拉起默认浏览器），成功即返；
 * - 直调失败（非 Tauri / 后端 spawn 失败）才经 `resolveFallbackOpener()` 拿劫持前
 *   原生 opener 兜底（直接 `window.open` 会被劫持返回 null），返回 null（弹窗拦截/
 *   无原生）则抛错保留失败感知，杜绝全部打不开又不谎报成功。
 */
export async function openPrefillPage(url: string): Promise<void> {
  const trimmed = (url ?? '').trim();
  if (!trimmed) throw new Error('empty url');
  try {
    await tauriApi.openUrl(trimmed);
    return;
  } catch (directErr) {
    const opener = resolveFallbackOpener();
    if (opener) {
      try {
        const ret = opener(trimmed, '_blank', 'noopener,noreferrer');
        if (ret) return;
      } catch {
        /* 原生调用抛错则落到下方抛出来源错 */
      }
    }
    throw directErr;
  }
}

/**
 * 后端载荷复制：取后端产出的载荷文本并原样写入剪贴板（不 trim、不重新格式化）。
 * provider 缺席或取载荷/复制失败一律返回 false，由调用方走链接复制退化路径。
 */
export async function copyBackendPayload(load: () => Promise<string>): Promise<boolean> {
  try {
    const payload = await load();
    if (typeof payload !== 'string' || !payload.trim()) return false;
    return await copyTextToClipboard(payload);
  } catch {
    return false;
  }
}

/**
 * 预填页打开失败：真实 https 链接先复制到剪贴板再 toast（已复制链接，请手动打开）；
 * 复制失败或传入的非链接标识（invalid-URL 守卫传 id）只报 plain open_failed，不谎报已复制。
 */
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
        defaultValue: `预填页打开失败：${message}；已复制链接，请手动打开`,
      }),
      'error',
    );
    return;
  }
  notify(
    t('pending.pr.open_failed', { message, defaultValue: `预填页打开失败：${message}` }),
    'error',
  );
}

/** 共享尾段参数（单条/批量差异全部由此表达，行为与拆分前逐行同口径）。 */
export interface SubmitPrefillFlowArgs {
  /** 预填 URL 提供方（单条 getCustomAppPrUrl / 批量 getCustomAppsBatchPrUrl）；缺席即预览模式硬拦。 */
  loadUrl: (() => Promise<string>) | undefined;
  /** 后端提交载荷提供方（超长时优先复制）；缺席退化为复制链接。 */
  loadPayload: (() => Promise<string>) | undefined;
  /** 非法 URL 提示里的目标标识（trim 后为空才用：单条传 id、批量传 ids.join('、') || 'batch'）。 */
  failLabel: string;
  /** 超长提示附加 i18n 参数（批量附 count，单条为空对象）。 */
  tooLongParams: Record<string, unknown>;
  /** 预填页打开成功后的收尾（批量清选中 + batch_submitted；单条为空）。 */
  onOpened?: () => void;
}

/**
 * 单条/批量提交共享尾段（busy 置位后调用）：
 * 预览模式硬拦 → 取 URL（后端门禁错透出 toast 中止）→ https 门（fail-closed）→
 * 超长（> PREFILL_URL_LENGTH_LIMIT）优先复制后端载荷、否则提示分批并复制链接 →
 * 打开预填页（失败复制链接并 toast，不谎报成功）→ 成功后执行 onOpened 收尾。
 * 任何失败路径均不开成功 toast、不触发 onOpened。
 */
export async function runSubmitPrefillFlow(
  deps: { t: TFunction; notify: Notify },
  args: SubmitPrefillFlowArgs,
): Promise<void> {
  const { t, notify } = deps;
  // 先取 URL：后端门禁错直接透出 toast，中止不开页；无回调即预览模式不可提交。
  if (!args.loadUrl) {
    notify(
      t('pending.pr.preview_only', {
        defaultValue: '预览模式仅演示，提交 Issue 请在桌面版完成',
      }),
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
  // 预填链接长度判定（含 percent-encoding 膨胀，按编码后 URL 全长计，与 Spec §5 对齐）。
  if (url.length > PREFILL_URL_LENGTH_LIMIT) {
    const payloadCopied = args.loadPayload ? await copyBackendPayload(args.loadPayload) : false;
    if (payloadCopied) {
      notify(
        t('pending.pr.payload_copied', {
          length: url.length,
          defaultValue: `预填链接过长（${url.length} 字符），已复制提交载荷，正在打开预填页`,
        }),
        'success',
      );
    } else {
      notify(
        t('pending.pr.url_too_long', {
          length: url.length,
          ...args.tooLongParams,
          defaultValue: `预填链接过长（${url.length} 字符），建议分批提交`,
        }),
        'warning',
      );
      if (await copyTextToClipboard(url)) {
        notify(
          t('pending.pr.url_copied_open_hint', {
            defaultValue: '已复制预填链接，可直接粘贴到浏览器打开',
          }),
          'info',
        );
      }
    }
  }
  try {
    await openPrefillPage(url);
  } catch (e) {
    await notifyPrefillOpenFailed(url, e, t, notify);
    return;
  }
  args.onOpened?.();
}
