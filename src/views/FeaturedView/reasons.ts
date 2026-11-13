import type { TFunction } from 'i18next';
import type { AppSummary, FeaturedReason, SeedRelation } from '../../types';
import { getCategoryLabel } from '../../utils/appHelper';

/** 种子应用的显示名：命中目录取名称，否则取仓库名。 */
export function seedDisplayName(seedId: string, appById: ReadonlyMap<string, AppSummary>): string {
  const hit = appById.get(seedId.toLowerCase());
  if (hit?.name) return hit.name;
  const repo = seedId.split('/').pop();
  return repo || seedId;
}

/** 「因为你 X 了 Y」：推荐理由与 because_you 货架标题共用。 */
export function seedPhrase(t: TFunction, relation: SeedRelation, name: string): string {
  return t(`featured.reason.seed_${relation}`, { name });
}

export function categoryName(t: TFunction, category: string): string {
  return getCategoryLabel(category, category, t);
}

export function formatReason(
  t: TFunction,
  reason: FeaturedReason,
  appById: ReadonlyMap<string, AppSummary>,
): string {
  switch (reason.kind) {
    case 'seed':
      return seedPhrase(t, reason.relation, seedDisplayName(reason.seed_id, appById));
    case 'category':
      return t('featured.reason.category', { category: categoryName(t, reason.category) });
    case 'owner':
      return t('featured.reason.owner', { owner: reason.owner });
    case 'keywords':
      return t('featured.reason.keywords', { tokens: reason.tokens.join(' / ') });
    case 'fresh':
      return t('featured.reason.fresh', { date: reason.added_at });
    case 'explore':
      return t('featured.reason.explore', { category: categoryName(t, reason.category) });
    default:
      return '';
  }
}

/** 多条理由以「 · 」连接，空理由返回 `undefined`（卡片不渲染理由行）。 */
export function formatReasons(
  t: TFunction,
  reasons: readonly FeaturedReason[] | undefined,
  appById: ReadonlyMap<string, AppSummary>,
): string | undefined {
  if (!reasons || reasons.length === 0) return undefined;
  const text = reasons
    .map((r) => formatReason(t, r, appById))
    .filter((s) => s.trim() !== '')
    .join(' · ');
  return text === '' ? undefined : text;
}
