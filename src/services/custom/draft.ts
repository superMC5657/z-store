import type { AppSummary } from '../../types';
import { tauriApi } from '../api';
import { buildCustomDraftItemFromSummary, draftForgeGateError, type CustomCatalogItem } from '../api/catalog';
import { resolveRemoteIconUrl } from './iconUrl';

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
 * - forge 门先行（#35，后端 DraftLenient 同口径）：非 GitHub 仓库/forge 形态 id
 *   入口即拒（`ok=false`，不落库不广播；builder 内同门 throw 兜底，不越层到视图）；
 * - 图标只认 `restoreOrFetchIconCycle().remote_url` 的 http(s) 真值；
 *   探测失败回退摘要图标归一，绝不伪造；
 * - 落库失败不广播，返回 `ok=false`（视图 toast 后即可，不抛异常）。
 */
export async function moveInToDraft(app: AppSummary): Promise<MoveInResult> {
  const gateError = draftForgeGateError(app);
  if (gateError) {
    return { ok: false, id: app.id, error: gateError };
  }
  let iconRemote: string | undefined;
  // 探测失败回退摘要图标归一（`catch` 已吞掉拒绝），绝不伪造 remote 真值。
  const cycle = await tauriApi.restoreOrFetchIconCycle(app.id).catch(() => null);
  const remote = resolveRemoteIconUrl(cycle);
  if (remote !== '') iconRemote = remote;
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
