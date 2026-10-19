import type { AppSummary } from '../../types';
import { tauriApi } from '../api';
import { buildCustomDraftItemFromSummary, type CustomCatalogItem } from '../api/catalog';

/** 移入收录结果：成功时带回落库草稿（含 canonical id），失败带回原因供视图本地化提示。 */
export interface MoveInResult {
  ok: boolean;
  id: string;
  item?: CustomCatalogItem;
  error?: string;
}

/**
 * 移入收录（唯一入口）：探测 remote 图标真值 → 按摘要合成草稿 payload → 落库草稿
 * → 广播 `zstore:custom-apps-changed`。提示文案由视图持有（本地化边界不越层）。
 *
 * - 图标只认 `restoreOrFetchIconCycle().remote_url` 的 http(s) 真值；
 *   探测失败回退摘要图标归一，绝不伪造；
 * - 落库失败不广播，返回 `ok=false`（视图 toast 后即可，不抛异常）。
 */
export async function moveInToDraft(app: AppSummary): Promise<MoveInResult> {
  let iconRemote: string | undefined;
  try {
    const cycle = await tauriApi.restoreOrFetchIconCycle(app.id).catch(() => null);
    const remote = typeof cycle?.remote_url === 'string' ? cycle.remote_url.trim() : '';
    if (/^https?:\/\//i.test(remote)) iconRemote = remote;
  } catch {
    // remote truth unavailable: fall back to app.icon normalization, never fabricate
  }
  const draft = buildCustomDraftItemFromSummary(app, iconRemote);
  try {
    await tauriApi.saveCustomApp(draft);
  } catch (e) {
    return {
      ok: false,
      id: draft.id,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  window.dispatchEvent(
    new CustomEvent('zstore:custom-apps-changed', { detail: { id: draft.id } }),
  );
  return { ok: true, id: draft.id, item: draft };
}
