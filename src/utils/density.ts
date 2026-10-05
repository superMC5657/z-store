/** Shared density helpers (single source for font scale + app zoom factor). */
export const FONT_SCALE_MAP: Record<string, string> = {
  '12': '0.86',
  '14': '1',
  '16': '1.14',
  '18': '1.28',
  '20': '1.43',
  small: '0.86',
  standard: '1',
  medium: '1.14',
  large: '1.28',
};

export function fontScaleFor(key: string): string {
  return FONT_SCALE_MAP[key] ?? '1';
}

/** Parse a ui_scale string ("100" → 1). Returns null when invalid. */
export function appZoomFactor(scaleStr: string): number | null {
  const factor = Number(scaleStr) / 100;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return factor;
}
