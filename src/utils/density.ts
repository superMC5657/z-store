/** Shared density helpers (single source for font scale + app zoom factor). */
const FONT_SCALE_MAP: Record<string, string> = {
  '12': '0.86',
  '14': '1',
  '16': '1.14',
  '18': '1.14',
  '20': '1.14',
  small: '0.86',
  standard: '1',
  medium: '1.14',
  large: '1.14',
};

const FONT_SIZE_TO_PRESET: Record<string, '12' | '14' | '16'> = {
  '12': '12',
  small: '12',
  '14': '14',
  standard: '14',
  '16': '16',
  medium: '16',
  '18': '16',
  large: '16',
  '20': '16',
};

export function fontScaleFor(key: string): string {
  return FONT_SCALE_MAP[key] ?? '1';
}

export function normalizeFontSizePreset(key: string): '12' | '14' | '16' {
  return FONT_SIZE_TO_PRESET[key] ?? '14';
}

const VALID_UI_SCALES = new Set(['100', '110', '125', '150']);

/** Parse a ui_scale string ("100" → 1). Non-standard/legacy values (e.g. "90") normalize to 1. */
export function appZoomFactor(scaleStr: string): number | null {
  const normalized = VALID_UI_SCALES.has(scaleStr) ? scaleStr : '100';
  const factor = Number(normalized) / 100;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return factor;
}
