import React, { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { tauriApi } from '../../services/api';
import { queueAssembledRowIcons } from '../../services/iconStore';
import { formatStars } from '../../services/trends';
import type { AppDetailViewModel, RecommendationReason, SimilarAppItem } from '../../types';
import { getCategoryLabel } from '../../utils/appHelper';
import { AppIconFrame } from '../AppIconFrame';
import { CountBadge } from '../CountBadge';
import { PlatformIcon } from '../icons/PlatformIcons';

interface SimilarAppsSectionProps {
  app: AppDetailViewModel;
  onSelectApp?: (id: string) => void;
  onTargetAlternatives?: (appId: string, alternatives: string[]) => void;
}

/** 从后端返回的理由数组中按可读性优先级提取单条精简说明（owner > keywords > category）。 */
export function pickSimilarReasonLabel(
  reasons: readonly RecommendationReason[] | undefined,
  t: TFunction,
): string | null {
  if (!reasons || reasons.length === 0) return null;
  const owner = reasons.find((r) => r.kind === 'owner');
  if (owner && owner.kind === 'owner') {
    return t('detail.similar.reason_owner', { owner: owner.owner });
  }
  const kw = reasons.find((r) => r.kind === 'keywords');
  if (kw && kw.kind === 'keywords' && kw.tokens.length > 0) {
    return t('detail.similar.reason_keywords', { tokens: kw.tokens.slice(0, 2).join(' / ') });
  }
  const cat = reasons.find((r) => r.kind === 'category');
  if (cat && cat.kind === 'category' && cat.category.trim() !== '') {
    return t('detail.similar.reason_category', {
      category: getCategoryLabel(cat.category, cat.category, t),
    });
  }
  return null;
}

export const SimilarAppsSection: React.FC<SimilarAppsSectionProps> = ({
  app,
  onSelectApp,
  onTargetAlternatives,
}) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<SimilarAppItem[]>([]);
  const reqRef = useRef(0);
  const lastAppIdRef = useRef<string>('');
  const onTargetAlternativesRef = useRef(onTargetAlternatives);
  onTargetAlternativesRef.current = onTargetAlternatives;

  useEffect(() => {
    const appId = app.id.trim();
    if (!appId) {
      setItems([]);
      return;
    }
    if (lastAppIdRef.current !== appId) {
      lastAppIdRef.current = appId;
      setItems([]);
    }

    const seq = ++reqRef.current;
    let isMounted = true;

    Promise.resolve(
      tauriApi.getSimilarApps({
        appId,
        name: app.name,
        owner: app.owner,
        category: app.category,
        description: app.description,
        descriptionEn: app.description_en,
        limit: 4,
      }),
    )
      .then((res) => {
        if (!isMounted || reqRef.current !== seq || !res) return;
        const nextItems = Array.isArray(res.items) ? res.items : [];
        setItems((prev) => (prev.length === 0 && nextItems.length === 0 ? prev : nextItems));
        if (nextItems.length > 0) {
          queueAssembledRowIcons(nextItems.map((entry) => entry.app));
        }
        const alts = Array.isArray(res.target_alternatives) ? res.target_alternatives : [];
        if (alts.length > 0) {
          onTargetAlternativesRef.current?.(appId, alts);
        }
      })
      .catch(() => {
        if (!isMounted || reqRef.current !== seq) return;
        setItems((prev) => (prev.length === 0 ? prev : []));
      });

    return () => {
      isMounted = false;
    };
  }, [app.id, app.name, app.owner, app.category, app.description, app.description_en, app.isLoading]);

  if (items.length === 0) return null;

  return (
    <section className="detail-similar-section" data-testid="detail-similar-section">
      <h3 className="detail-similar-title">
        <span>{t('detail.similar.title')}</span>
        <CountBadge value={items.length} />
      </h3>
      <div className="detail-similar-grid">
        {items.map((entry) => {
          const reasonLabel = pickSimilarReasonLabel(entry.reasons, t);
          return (
            <button
              key={entry.app.id}
              type="button"
              className="detail-similar-card"
              data-testid={`similar-card-${entry.app.id}`}
              onClick={() => onSelectApp?.(entry.app.id)}
            >
              <div className="detail-similar-card-head">
                <AppIconFrame
                  size="sm"
                  icon={entry.app.icon}
                  name={entry.app.name}
                  appId={entry.app.id}
                  iconBg={entry.app.icon_bg}
                />
                <div className="detail-similar-card-meta">
                  <span className="detail-similar-card-name" title={entry.app.name}>
                    {entry.app.name}
                  </span>
                  <span className="detail-similar-card-stats">
                    <span>★ {formatStars(entry.app.stars)}</span>
                    {entry.app.platforms && entry.app.platforms.length > 0 && (
                      <span className="detail-similar-card-platforms">
                        {entry.app.platforms.slice(0, 4).map((p) => (
                          <PlatformIcon key={p} platform={p} size={11} />
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              </div>
              {reasonLabel && (
                <span className="status-tag detail-similar-reason" title={reasonLabel}>
                  {reasonLabel}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
};
