import React from 'react';
import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface VerifiedBadgeProps {
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const VerifiedBadge: React.FC<VerifiedBadgeProps> = ({
  size = 'sm',
  title,
  className = '',
  style,
}) => {
  const { t } = useTranslation();
  const iconSize = size === 'md' ? 18 : 13;
  const strokeWidth = size === 'md' ? 2 : 2.2;
  const resolvedTitle = title || t('app.verified_badge');

  return (
    <span
      className={`verified-badge verified-badge-${size} ${className}`.trim()}
      title={resolvedTitle}
      style={style}
    >
      <BadgeCheck size={iconSize} strokeWidth={strokeWidth} />
    </span>
  );
};
