import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Sun,
  Moon,
  Laptop,
  Languages,
  Globe,
} from 'lucide-react';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { normalizeFontSizePreset } from '../../../utils/density';
import type { AppSettings } from '../../../types';

interface AppearanceSectionProps {
  currentTheme: 'light' | 'dark' | 'system';
  language: string;
  uiScale: string;
  fontSize: AppSettings['font_size'];
  highlightRow: string | null;
  activeNotice: { key: string; text: string } | null;
  onSelectTheme: (theme: 'light' | 'dark' | 'system') => void;
  onSelectLanguage: (lang: 'zh-CN' | 'en-US') => void;
  onSelectUiScale: (scale: '100' | '110' | '125' | '150') => void;
  onSelectFontSize: (val: AppSettings['font_size'], label: string) => void;
}

const UI_SCALE_OPTIONS = ['100', '110', '125', '150'] as const;

const FONT_SIZE_OPTIONS = [
  { value: '12', labelKey: 'settings.font_size_compact' as const },
  { value: '14', labelKey: 'settings.font_size_standard' as const },
  { value: '16', labelKey: 'settings.font_size_comfortable' as const },
] as const;

export const AppearanceSection: React.FC<AppearanceSectionProps> = ({
  currentTheme,
  language,
  uiScale,
  fontSize,
  highlightRow,
  activeNotice,
  onSelectTheme,
  onSelectLanguage,
  onSelectUiScale,
  onSelectFontSize,
}) => {
  const { t } = useTranslation();
  const fontSizeOptions = FONT_SIZE_OPTIONS.map((item) => ({
    value: item.value,
    label: t(item.labelKey),
  }));
  const activeFontSize = normalizeFontSizePreset(fontSize);
  const activeUiScale = UI_SCALE_OPTIONS.includes(uiScale as any) ? (uiScale as AppSettings['ui_scale']) : '100';

  return (
    <>
      <div className={`settings-row ${highlightRow === 'theme' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.theme_mode')}</span>
            {activeNotice?.key === 'theme' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <SegmentedControl
          value={currentTheme}
          onChange={(val) => onSelectTheme(val as 'light' | 'dark' | 'system')}
          options={[
            {
              value: 'light',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Sun size={13} strokeWidth={1.5} />
                  <span>{t('settings.theme_light')}</span>
                </span>
              ),
            },
            {
              value: 'dark',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Moon size={13} strokeWidth={1.5} />
                  <span>{t('settings.theme_dark')}</span>
                </span>
              ),
            },
            {
              value: 'system',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Laptop size={13} strokeWidth={1.5} />
                  <span>{t('settings.theme_system')}</span>
                </span>
              ),
            },
          ]}
        />
      </div>

      <div className={`settings-row ${highlightRow === 'language' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.language_title')}</span>
            {activeNotice?.key === 'language' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <SegmentedControl
          value={language}
          onChange={(val) => onSelectLanguage(val as 'zh-CN' | 'en-US')}
          options={[
            {
              value: 'zh-CN',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Languages size={13} strokeWidth={1.5} />
                  <span>简体中文</span>
                </span>
              ),
            },
            {
              value: 'en-US',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Globe size={13} strokeWidth={1.5} />
                  <span>English</span>
                </span>
              ),
            },
          ]}
        />
      </div>

      <div className={`settings-row ${highlightRow === 'ui_scale' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.ui_scale')}</span>
            {activeNotice?.key === 'ui_scale' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <SegmentedControl
          value={activeUiScale}
          onChange={(val) => onSelectUiScale(val as AppSettings['ui_scale'])}
          options={UI_SCALE_OPTIONS.map((scale) => ({
            value: scale,
            label: `${scale}%`,
          }))}
        />
      </div>

      <div className={`settings-row ${highlightRow === 'font_size' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.font_size')}</span>
            {activeNotice?.key === 'font_size' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <SegmentedControl
          value={activeFontSize}
          onChange={(val) => {
            const matched = fontSizeOptions.find((opt) => opt.value === val);
            onSelectFontSize(val as AppSettings['font_size'], String(matched?.label || `${val}px`));
          }}
          options={fontSizeOptions}
        />
      </div>
    </>
  );
};
