import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sliders,
  Check,
  Sun,
  Moon,
  Laptop,
  Languages,
  Globe,
  Eye,
  EyeOff,
} from 'lucide-react';
import { SegmentedControl } from '../../../components/SegmentedControl';
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
  onSelectUiScale: (scale: '90' | '100' | '110' | '125') => void;
  onSelectFontSize: (val: AppSettings['font_size'], label: string) => void;
  /** 待提交分栏显示 owner/repo 坐标；缺席按显示处理。 */
  showCoords?: boolean;
  /** 切换上述坐标显示。 */
  onToggleShowCoords?: (show: boolean) => void;
}

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
  showCoords,
  onToggleShowCoords,
}) => {
  const { t } = useTranslation();
  const effectiveShowCoords = showCoords ?? true;
  const handleToggleShowCoords = onToggleShowCoords;

  return (
    <div className="settings-group">
      <div className="settings-group-title">
        <Sliders size={15} strokeWidth={1.5} />
        <span>{t('settings.appearance', { defaultValue: '外观与个性化' })}</span>
      </div>
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
          value={uiScale}
          onChange={(val) => onSelectUiScale(val as '90' | '100' | '110' | '125')}
          options={(['90', '100', '110', '125'] as const).map((scale) => ({
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
          value={
            fontSize === 'standard'
              ? '14'
              : fontSize === 'small'
              ? '12'
              : fontSize
          }
          onChange={(val) => {
            const opt = [
              { id: '12', label: '12px' },
              { id: '14', label: '14px' },
              { id: '16', label: '16px' },
              { id: '18', label: '18px' },
              { id: '20', label: '20px' },
            ].find((f) => f.id === val);
            onSelectFontSize(val, opt?.label || `${val}px`);
          }}
          options={[
            { value: '12', label: '12px' },
            { value: '14', label: '14px' },
            { value: '16', label: '16px' },
            { value: '18', label: '18px' },
            { value: '20', label: '20px' },
          ]}
        />
      </div>

      <div className={`settings-row ${highlightRow === 'pending_coords' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.pending_coords_title')}</span>
            {activeNotice?.key === 'pending_coords' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            {t('settings.pending_coords_desc')}
          </span>
        </div>
        <SegmentedControl
          value={effectiveShowCoords ? 'show' : 'hide'}
          onChange={(val) => handleToggleShowCoords?.(val === 'show')}
          options={[
            {
              value: 'show',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Eye size={13} strokeWidth={1.5} />
                  <span>{t('settings.pending_coords_show')}</span>
                </span>
              ),
            },
            {
              value: 'hide',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <EyeOff size={13} strokeWidth={1.5} />
                  <span>{t('settings.pending_coords_hide')}</span>
                </span>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
};
