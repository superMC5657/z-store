import type { AppSummary } from '../../types';
import { tauriApi } from '../api';
import { buildCustomDraftItemFromSummary, draftForgeGateError, type CustomCatalogItem } from '../api/catalog';
import { resolveRemoteIconUrl } from './iconUrl';

/** 移入收录结果：成功时带回落库草稿（含 canonical id），失败带回原因供视图本地化提示。 */
interface MoveInResult {
  ok: boolean;
  id: string;
  item?: CustomCatalogItem;
  error?: string;
}

/**
 * 移入收录（唯一入口）：解析详情补齐协议/平台/版本 → 探测 remote 图标真值
 * → 按摘要合成草稿 payload → 落库草稿 → 广播 `zstore:custom-apps-changed`。
 * 提示文案由视图持有（本地化边界不越层）。
 *
 * - forge 门先行（后端 DraftLenient 同口径）：非 GitHub 仓库/forge 形态 id
 *   入口即拒（`ok=false`，不落库不广播；builder 内同门 throw 兜底，不越层到视图）；
 * - 协议占位符（如 OpenSource/unknown/空）时拉取应用详情回填真实 SPDX 开源协议与平台；
 * - 图标只认 `restoreOrFetchIconCycle().remote_url` 的 http(s) 真值；
 *   探测失败回退摘要图标归一，绝不伪造；
 * - 落库失败不广播，返回 `ok=false`（视图 toast 后即可，不抛异常）。
 */
export async function moveInToDraft(app: AppSummary): Promise<MoveInResult> {
  const gateError = draftForgeGateError(app);
  if (gateError) {
    return { ok: false, id: app.id, error: gateError };
  }

  let effectiveApp = app;
  const rawLic = typeof app.license === 'string' ? app.license.trim() : '';
  const isLicensePlaceholder =
    !rawLic ||
    rawLic.toLowerCase() === 'opensource' ||
    rawLic.toLowerCase() === 'unknown';

  if (isLicensePlaceholder) {
    const detail = await tauriApi.getAppDetails(app.id).catch(() => null);
    if (detail) {
      const realLic = typeof detail.license === 'string' ? detail.license.trim() : '';
      const isDetailPlaceholder =
        !realLic ||
        realLic.toLowerCase() === 'opensource' ||
        realLic.toLowerCase() === 'unknown';

      effectiveApp = {
        ...app,
        description: app.description || detail.description,
        description_en: detail.description_en || app.description_en,
        license: !isDetailPlaceholder ? realLic : (rawLic || 'OpenSource'),
        homepage: detail.homepage || app.homepage,
        platforms:
          detail.platforms && detail.platforms.length > 0
            ? detail.platforms
            : app.platforms,
        latest_version: detail.latest_version || app.latest_version,
      };
    }
  }

  let iconRemote: string | undefined;
  // 探测失败回退摘要图标归一（`catch` 已吞掉拒绝），绝不伪造 remote 真值。
  const cycle = await tauriApi.restoreOrFetchIconCycle(effectiveApp.id).catch(() => null);
  const remote = resolveRemoteIconUrl(cycle);
  if (remote !== '') iconRemote = remote;
  const draft = buildCustomDraftItemFromSummary(effectiveApp, iconRemote);
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
