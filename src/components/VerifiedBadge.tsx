import React from 'react';
import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isLocalLibraryStatus } from '../app/selectors';

type VerifiedBadgeVariant = 'verified' | 'local';

interface VerifiedBadgeProps {
  size?: 'sm' | 'md';
  variant?: VerifiedBadgeVariant;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

/** 徽标变体判定：已认证远端优先返回 `verified`，本地收录返回 `local`，其余为 `null`。 */
export function resolveVerifiedBadgeVariant(app: {
  is_verified?: unknown;
  source?: unknown;
  status?: unknown;
}): VerifiedBadgeVariant | null {
  if ((app as { is_verified?: unknown }).is_verified === true) return 'verified';
  if ((app as { source?: unknown }).source === 'local') return 'local';
  const status = (app as { status?: unknown }).status;
  if (isLocalLibraryStatus(status)) return 'local';
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
