import React from 'react';

/** 超过该值显示为 `999+`，避免角标被长数字撑宽。 */
const COUNT_BADGE_MAX = 999;

export function formatCount(value: number): string {
  return value > COUNT_BADGE_MAX ? `${COUNT_BADGE_MAX}+` : String(value);
}

interface CountBadgeProps {
  value: number;
  /** 所属控件处于选中态（导航项 / tab / 分段）时为 true。 */
  active?: boolean;
  /** 入口型位置（导航、按钮）为 0 时不渲染；容器型位置（标题、tab）保留 0。 */
  hideZero?: boolean;
}

/**
 * 全站唯一的数量角标：灰底圆角矩形，紧跟在标签文本之后。
 * 前置一个空格文本节点：父级是 flex 容器时不占版面，但让读屏与 textContent 读作「标签 N」而非「标签N」。
 * 规范见 docs/count-display.md。
 */
export const CountBadge: React.FC<CountBadgeProps> = ({ value, active = false, hideZero = false }) => {
  if (!Number.isFinite(value) || value < 0) return null;
  if (hideZero && value === 0) return null;
  return (
    <>
      {' '}
      <span className={active ? 'count-badge is-active' : 'count-badge'}>{formatCount(value)}</span>
    </>
  );
};

interface CountLabelProps {
  icon?: React.ReactNode;
  label: string;
  count: number;
  active?: boolean;
}

/** tab / 分段选项的标准标签：可选图标 + 文本 + 数量角标，间距 6px。 */
export const CountLabel: React.FC<CountLabelProps> = ({ icon, label, count, active = false }) => (
  <span className="count-label">
    {icon}
    <span>{label}</span>
    <CountBadge value={count} active={active} />
  </span>
);
