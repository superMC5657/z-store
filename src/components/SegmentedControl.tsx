import React from 'react';

interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string | number> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  style?: React.CSSProperties;
  /** 尺寸档位：默认 34px 高（标准页面切换）；compact 为 30px 高（对齐 30px 搜索框，如 FavoritesView / RulesManagerModal）。 */
  size?: 'default' | 'compact';
  /** 无障碍名称（多组分段并存时区分，如趋势榜单维度切换）。 */
  ariaLabel?: string;
}

export function SegmentedControl<T extends string | number>({
  value,
  onChange,
  options,
  className = '',
  style,
  size = 'default',
  ariaLabel,
}: SegmentedControlProps<T>): React.ReactElement {
  const sizeClass = size === 'compact' ? 'segmented-compact' : '';
  return (
    <div className={`segmented-group ${sizeClass} ${className}`.trim()} style={style} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-pressed={isActive}
            className={`segmented-item ${isActive ? 'active' : ''}`}
            onClick={() => !option.disabled && onChange(option.value)}
            disabled={option.disabled}
            title={option.title}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
