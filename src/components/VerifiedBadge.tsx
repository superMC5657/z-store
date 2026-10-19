import React from 'react';
import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type VerifiedBadgeVariant = 'verified' | 'local';

export interface VerifiedBadgeProps {
  size?: 'sm' | 'md';
  variant?: VerifiedBadgeVariant;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 徽标变体判定（展示层唯一口径）：
 * 已认证优先 verified（蓝色不动），本地收录走 local（橘黄），其余无标。
 */
export function resolveVerifiedBadgeVariant(app: {
  is_verified?: unknown;
  source?: unknown;
  status?: unknown;
}): VerifiedBadgeVariant | null {
  if ((app as { is_verified?: unknown }).is_verified === true) return 'verified';
  if ((app as { source?: unknown }).source === 'local') return 'local';
  const status = (app as { status?: unknown }).status;
  if (status === 'collected' || status === 'local_collected') return 'local';
  return null;
}

export const VerifiedBadge: React.FC<VerifiedBadgeProps> = ({
  size = 'sm',
  variant = 'verified',
  title,
  className = '',
  style,
}) => {
  const { t } = useTranslation();
  const iconSize = size === 'md' ? 18 : 13;
  const strokeWidth = size === 'md' ? 2 : 2.2;
  const resolvedTitle =
    title ?? (variant === 'local' ? t('app.local_badge') : t('app.verified_badge'));

  return (
    <span
      className={`verified-badge verified-badge-${size}${variant === 'local' ? ' verified-badge-local' : ''} ${className}`.trim()}
      title={resolvedTitle}
      style={style}
    >
      <BadgeCheck size={iconSize} strokeWidth={strokeWidth} />
    </span>
  );
};
