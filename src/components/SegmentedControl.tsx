import React from 'react';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  style?: React.CSSProperties;
  /** 无障碍名称（多组分段并存时区分，如趋势榜单维度切换）。 */
  ariaLabel?: string;
}

export function SegmentedControl<T extends string | number>({
  value,
  onChange,
  options,
  className = '',
  style,
  ariaLabel,
}: SegmentedControlProps<T>): React.ReactElement {
  return (
    <div className={`segmented-group ${className}`.trim()} style={style} role="group" aria-label={ariaLabel}>
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
