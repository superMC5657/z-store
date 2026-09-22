import React, { useState, useEffect, useRef } from 'react';
import {
  Settings,
  Sun,
  Moon,
  Laptop,
  RotateCcw,
  Shield,
  FolderOpen,
  Globe,
  Zap,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  Check,
  Download,
  Languages,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppSettings, MirrorNodeStatus } from '../types';
import { api } from '../services/api';
import { ClientUpdateRow } from '../components/ClientUpdateRow';
import { OAuthAccountCard } from '../components/OAuthAccountCard';
import { DataBackupRow } from '../components/DataBackupRow';

interface SettingsViewProps {
  mirrors?: MirrorNodeStatus[];
  onSelectMirror: (id: string) => void;
  onPingMirrors?: () => void;
  theme: 'light' | 'dark' | 'system';
  onSetTheme: (theme: 'light' | 'dark' | 'system') => void;
  onExportAppsJson: () => void;
  settings: AppSettings;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onResetSettings?: () => Promise<void>;
  installedCount: number;
  updateRulesCount: number;
  onOpenRules: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  mirrors: _mirrors,
  onSelectMirror,
  onPingMirrors: _onPingMirrors,
  theme,
  onSetTheme,
  onExportAppsJson,
  settings,
  onUpdateSetting,
  onResetSettings: _onResetSettings,
  installedCount,
  updateRulesCount,
  onOpenRules,
}) => {
  const { t } = useTranslation();
  const currentTheme = theme || settings.theme;
  const [proxyInput, setProxyInput] = useState<string>(() => {
    const act = settings.active_mirror;
    if (!act || act === 'direct' || act === 'https://github.com') return '';
    if (act === 'ghproxy') return 'https://gh-proxy.com';
    return act;
  });
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{
    success: boolean;
    latency_ms: number;
    text: string;
    badge: string;
  } | null>(null);
  const [proxySavedFeedback, setProxySavedFeedback] = useState<string | null>(null);

  const [catalogSourceUrl, setCatalogSourceUrl] = useState(
    settings.catalog_source_url && !settings.catalog_source_url.includes('gitmirror.com') && !settings.catalog_source_url.includes('src-tauri/src/catalog.json')
      ? settings.catalog_source_url
      : ''
  );

  useEffect(() => {
    if (settings.catalog_source_url) {
      setCatalogSourceUrl(settings.catalog_source_url);
    }
  }, [settings.catalog_source_url]);
  const [catalogUrlSaved, setCatalogUrlSaved] = useState(false);
  const [showAdvancedSource, setShowAdvancedSource] = useState(false);
  const [isCatalogSourceConfirming, setIsCatalogSourceConfirming] = useState(false);

  // 动态动效与微交互状态
  const [activeNotice, setActiveNotice] = useState<{ key: string; text: string } | null>(null);
  const [highlightRow, setHighlightRow] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerChangeFeedback = (key: string, text: string) => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    setActiveNotice({ key, text });
    setHighlightRow(key);
    noticeTimerRef.current = setTimeout(() => {
      setActiveNotice((curr) => (curr?.key === key ? null : curr));
      setHighlightRow((curr) => (curr === key ? null : curr));
    }, 2200);
  };

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const [isSyncingCatalog, setIsSyncingCatalog] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  const handleSyncCatalog = async () => {
    setIsSyncingCatalog(true);
    setSyncFeedback(null);
    try {
      const res = await api.syncCatalog(true);
      setSyncFeedback(res.message);
      triggerChangeFeedback('catalog_sync', t('settings.catalog_sync_success'));
      setTimeout(() => setSyncFeedback(null), 5000);
      window.dispatchEvent(new CustomEvent('zstore:catalog-synced'));
    } catch (e) {
      setSyncFeedback(t('settings.catalog_sync_failed', { error: String(e) }));
    } finally {
      setIsSyncingCatalog(false);
    }
  };

  useEffect(() => {
    const act = settings.active_mirror;
    if (!act || act === 'direct' || act === 'https://github.com') {
      setProxyInput('');
    } else if (act === 'ghproxy') {
      setProxyInput('https://gh-proxy.com');
    } else if (act.startsWith('http://') || act.startsWith('https://')) {
      setProxyInput(act);
    }
  }, [settings.active_mirror]);

  const handleTestProxy = async () => {
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      const url = proxyInput.trim();
      const res = await api.testProxy(url || undefined);
      if (res.success) {
        setProxyTestResult({
          success: true,
          latency_ms: res.latency_ms,
          text: `${res.latency_ms} ms (${t('settings.test_latency_ok')})`,
          badge: '',
        });
      } else {
        setProxyTestResult({
          success: false,
          latency_ms: res.latency_ms,
          text: res.message || t('settings.test_latency_timeout'),
          badge: '',
        });
      }
    } catch (e) {
      setProxyTestResult({
        success: false,
        latency_ms: 9999,
        text: t('settings.test_failed', { error: String(e) }),
        badge: '',
      });
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleSaveProxy = async () => {
    const trimmed = proxyInput.trim();
    if (!trimmed || trimmed === 'direct') {
      await onSelectMirror('direct');
      onUpdateSetting('active_mirror', 'direct');
      setProxySavedFeedback(t('settings.proxy_saved_direct'));
      triggerChangeFeedback('proxy', '✓ ' + t('settings.proxy_active_direct'));
    } else {
      let finalUrl = trimmed;
      if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
        finalUrl = 'https://' + finalUrl;
        setProxyInput(finalUrl);
      }
      await onSelectMirror(finalUrl);
      onUpdateSetting('active_mirror', finalUrl);
      setProxySavedFeedback(t('settings.proxy_saved_custom', { url: finalUrl }));
      triggerChangeFeedback('proxy', '✓ ' + t('settings.save_proxy'));
    }
    setTimeout(() => setProxySavedFeedback(null), 3500);
  };



  const handleSelectTheme = (themeMode: 'light' | 'dark' | 'system') => {
    const labelMap: Record<string, string> = {
      light: t('settings.theme_light'),
      dark: t('settings.theme_dark'),
      system: t('settings.theme_system'),
    };
    triggerChangeFeedback('theme', `✓ ${labelMap[themeMode]}`);
    onSetTheme(themeMode);
  };

  const handleSelectLanguage = (lng: 'zh-CN' | 'en-US') => {
    triggerChangeFeedback('language', lng === 'zh-CN' ? '✓ 简体中文' : '✓ English');
    onUpdateSetting('language', lng);
  };

  const handleSelectUiScale = (scale: '90' | '100' | '110' | '125') => {
    triggerChangeFeedback('ui_scale', `✓ ${scale}%`);
    onUpdateSetting('ui_scale', scale);
  };

  const handleSelectFontSize = (id: string, label: string) => {
    triggerChangeFeedback('font_size', `✓ ${label}`);
    onUpdateSetting('font_size', id as any);
  };


  const handleSelectUpdateFrequency = (id: string, label: string) => {
    triggerChangeFeedback('update_frequency', `✓ ${label}`);
    onUpdateSetting('update_frequency', id as any);
  };

  // FR-6.2: 关注更新的应用内提醒频率（每次启动 / 每天），经 user_settings 持久化
  const handleSelectWatchFrequency = (id: 'startup' | 'daily', label: string) => {
    triggerChangeFeedback('watch_notify_frequency', `✓ ${label}`);
    onUpdateSetting('watch_notify_frequency', id);
  };


  const handleExportJson = () => {
    onExportAppsJson();
    triggerChangeFeedback('export', '✓ ' + t('settings.export_apps'));
  };

  // P3-3 信任阻尼：切换至非默认（自定义）收录源将替换受信任的目录，
  // 属于敏感破坏性操作，必须经过二次显式确认。保存为空值（即恢复官方默认源流）立即生效。
  const pendingCatalogUrl = catalogSourceUrl.trim();
  const isCustomCatalogSourceChange =
    pendingCatalogUrl.length > 0 && pendingCatalogUrl !== (settings.catalog_source_url || '').trim();

  const handleSaveCatalogSource = () => {
    if (isCustomCatalogSourceChange && !isCatalogSourceConfirming) {
      setIsCatalogSourceConfirming(true);
      return;
    }
    onUpdateSetting('catalog_source_url', pendingCatalogUrl);
    setIsCatalogSourceConfirming(false);
    setCatalogUrlSaved(true);
    triggerChangeFeedback('catalog_source', '✓ ' + t('settings.catalog_sync_title'));
    setTimeout(() => setCatalogUrlSaved(false), 2500);
  };

  return (
    <div className="settings-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">
          <Settings size={18} />
          <span>{t('settings.title')}</span>
        </h3>
      </div>

      <div className="settings-group">
        <div className={`settings-row ${highlightRow === 'theme' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.theme_mode')}</span>
              {activeNotice?.key === 'theme' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="segmented-group">
            <button
              className={`segmented-item ${currentTheme === 'light' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('light')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Sun size={13} />
              <span>{t('settings.theme_light')}</span>
            </button>
            <button
              className={`segmented-item ${currentTheme === 'dark' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('dark')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Moon size={13} />
              <span>{t('settings.theme_dark')}</span>
            </button>
            <button
              className={`segmented-item ${currentTheme === 'system' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('system')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Laptop size={13} />
              <span>{t('settings.theme_system')}</span>
            </button>
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'language' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.language_title')}</span>
              {activeNotice?.key === 'language' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="segmented-group">
            <button
              className={`segmented-item ${settings.language === 'zh-CN' ? 'active' : ''}`}
              onClick={() => handleSelectLanguage('zh-CN')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Languages size={13} />
              <span>简体中文</span>
            </button>
            <button
              className={`segmented-item ${settings.language === 'en-US' ? 'active' : ''}`}
              onClick={() => handleSelectLanguage('en-US')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Globe size={13} />
              <span>English</span>
            </button>
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'ui_scale' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.ui_scale')}</span>
              {activeNotice?.key === 'ui_scale' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="segmented-group">
            {(['90', '100', '110', '125'] as const).map((scale) => (
              <button
                key={scale}
                className={`segmented-item ${settings.ui_scale === scale ? 'active' : ''}`}
                onClick={() => handleSelectUiScale(scale)}
              >
                {scale}%
              </button>
            ))}
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'font_size' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.font_size')}</span>
              {activeNotice?.key === 'font_size' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="segmented-group">
            {[
              { id: '12', label: '12px' },
              { id: '14', label: '14px' },
              { id: '16', label: '16px' },
              { id: '18', label: '18px' },
              { id: '20', label: '20px' },
            ].map((f) => (
              <button
                key={f.id}
                className={`segmented-item ${
                  settings.font_size === f.id ||
                  (f.id === '14' && settings.font_size === 'standard') ||
                  (f.id === '12' && settings.font_size === 'small')
                    ? 'active'
                    : ''
                }`}
                onClick={() => handleSelectFontSize(f.id, f.label)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className={`settings-row ${highlightRow === 'update_frequency' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.update_frequency')}</span>
              {activeNotice?.key === 'update_frequency' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="segmented-group">
            {[
              { id: 'startup', label: t('settings.freq_startup') },
              { id: 'manual', label: t('settings.freq_manual') },
            ].map((u) => (
              <button
                key={u.id}
                className={`segmented-item ${settings.update_frequency === u.id ? 'active' : ''}`}
                onClick={() => handleSelectUpdateFrequency(u.id, u.label)}
              >
                {u.label}
              </button>
            ))}
          </div>
        </div>

        <ClientUpdateRow />

        <div className={`settings-row ${highlightRow === 'watch_notify_frequency' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.watch_notify_frequency')}</span>
              {activeNotice?.key === 'watch_notify_frequency' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="segmented-group">
            {[
              { id: 'startup', label: t('settings.watch_startup') },
              { id: 'daily', label: t('settings.watch_daily') },
            ].map((o) => (
              <button
                key={o.id}
                className={`segmented-item ${settings.watch_notify_frequency === o.id ? 'active' : ''}`}
                onClick={() => handleSelectWatchFrequency(o.id as 'startup' | 'daily', o.label)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row" style={{ alignItems: 'center' }}>
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>{t('settings.rules_title')}</span>
          </div>
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={onOpenRules}
            style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Shield size={13} />
            <span>{t('settings.rules_btn')}</span>
            {updateRulesCount > 0 && (
              <span
                style={{
                  fontSize: '11px',
                  padding: '1px 7px',
                  borderRadius: '10px',
                  background: 'var(--brand-primary)',
                  color: '#000',
                  fontWeight: 600,
                }}
              >
                {updateRulesCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="settings-group">
        <div className={`settings-row ${highlightRow === 'download_dir' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.download_dir')}</span>
              {activeNotice?.key === 'download_dir' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="settings-input-group">
            <input
              type="text"
              className={`settings-input ${highlightRow === 'download_dir' ? 'input-highlight' : ''}`}
              value={settings.download_dir || '~/Downloads'}
              onChange={(e) => onUpdateSetting('download_dir', e.target.value)}
              placeholder="~/Downloads"
            />
            <button
              type="button"
              className="btn-fluent btn-secondary"
              onClick={async () => {
                try {
                  const picked = await api.selectFolder(settings.download_dir, t('settings.select_download_dir'));
                  if (picked) {
                    onUpdateSetting('download_dir', picked);
                    triggerChangeFeedback('download_dir', '✓ ' + t('settings.download_dir'));
                  }
                } catch {
                  /* 用户取消了文件夹选择器 */
                }
              }}
            >
              <FolderOpen size={13} />
              <span>{t('settings.browse')}</span>
            </button>
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'portable_dir' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.portable_dir')}</span>
              {activeNotice?.key === 'portable_dir' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div className="settings-input-group">
            <input
              type="text"
              className={`settings-input ${highlightRow === 'portable_dir' ? 'input-highlight' : ''}`}
              value={settings.portable_dir || '%LOCALAPPDATA%\\Programs\\z-store-apps'}
              onChange={(e) => onUpdateSetting('portable_dir', e.target.value)}
              placeholder="%LOCALAPPDATA%\Programs\z-store-apps"
            />
            <button
              type="button"
              className="btn-fluent btn-secondary"
              onClick={async () => {
                try {
                  const picked = await api.selectFolder(settings.portable_dir, t('settings.select_portable_dir'));
                  if (picked) {
                    onUpdateSetting('portable_dir', picked);
                    triggerChangeFeedback('portable_dir', '✓ ' + t('settings.portable_dir'));
                  }
                } catch {
                  /* 用户取消了文件夹选择器 */
                }
              }}
            >
              <FolderOpen size={13} />
              <span>{t('settings.browse')}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div id="settings-account">
          <OAuthAccountCard />
        </div>

        <div className={`settings-row ${highlightRow === 'proxy' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.proxy_title')}</span>
              {proxyTestResult && (
                <span
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: !proxyTestResult.success ? '#ef4444' : proxyTestResult.latency_ms < 400 ? '#10b981' : proxyTestResult.latency_ms < 1000 ? '#f59e0b' : '#ea580c',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span className={`status-dot ${!proxyTestResult.success ? 'status-dot-error' : proxyTestResult.latency_ms < 400 ? 'status-dot-success' : proxyTestResult.latency_ms < 1000 ? 'status-dot-warning' : 'status-dot-error'}`} />
                  <span>{proxyTestResult.text}</span>
                </span>
              )}
              {proxySavedFeedback && (
                <span style={{ fontSize: '12px', color: '#10b981', fontWeight: 500 }}>
                  {proxySavedFeedback}
                </span>
              )}
              {activeNotice?.key === 'proxy' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>

          <div className="settings-input-group" style={{ maxWidth: '460px' }}>
            <input
              type="text"
              className={`settings-input ${highlightRow === 'proxy' ? 'input-highlight' : ''}`}
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
              placeholder={t('settings.proxy_placeholder')}
            />
            <button
              type="button"
              className="btn-fluent btn-secondary"
              onClick={handleTestProxy}
              disabled={isTestingProxy}
            >
              {isTestingProxy ? <RotateCcw size={12} className="icon-spin" /> : <Zap size={12} />}
              <span>{isTestingProxy ? t('settings.testing_speed') : t('settings.test_speed')}</span>
            </button>
            <button
              type="button"
              className="btn-fluent btn-primary"
              onClick={handleSaveProxy}
            >
              {t('settings.save_proxy')}
            </button>
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'catalog_source' || highlightRow === 'catalog_sync' ? 'row-highlight' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>{t('settings.catalog_sync_title')}</span>
                {(activeNotice?.key === 'catalog_source' || activeNotice?.key === 'catalog_sync') && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => setShowAdvancedSource(!showAdvancedSource)}
              >
                {showAdvancedSource ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                <span>{showAdvancedSource ? t('settings.catalog_collapse_btn') : t('settings.catalog_custom_btn')}</span>
              </button>
              <button
                type="button"
                className="btn-fluent btn-primary"
                onClick={handleSyncCatalog}
                disabled={isSyncingCatalog}
                style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                {isSyncingCatalog ? <RotateCcw size={12} className="icon-spin" /> : <RefreshCw size={12} />}
                <span>{isSyncingCatalog ? t('settings.catalog_syncing') : t('settings.catalog_sync_now')}</span>
              </button>
            </div>
          </div>

          {showAdvancedSource && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-acrylic-thin)',
                border: '1px solid var(--border-acrylic)',
              }}
            >
              <input
                type="text"
                className="settings-input"
                value={catalogSourceUrl}
                onChange={(e) => {
                  setCatalogSourceUrl(e.target.value);
                  setCatalogUrlSaved(false);
                  setIsCatalogSourceConfirming(false);
                }}
                placeholder="https://.../catalog.json"
              />
              {isCatalogSourceConfirming ? (
                <>
                  <button
                    type="button"
                    className="btn-fluent"
                    style={{ fontSize: '12px', padding: '0 12px', height: '32px', display: 'flex', alignItems: 'center', gap: '4px', background: '#ef4444', color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}
                    onClick={handleSaveCatalogSource}
                  >
                    <span>{t('settings.catalog_confirm_switch')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn-fluent btn-secondary"
                    style={{ fontSize: '12px', padding: '0 12px', height: '32px', whiteSpace: 'nowrap' }}
                    onClick={() => setIsCatalogSourceConfirming(false)}
                  >
                    <span>{t('common.cancel')}</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn-fluent btn-primary"
                  style={{ fontSize: '12px', padding: '0 14px', height: '32px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}
                  onClick={handleSaveCatalogSource}
                >
                  {catalogUrlSaved && <Check size={12} />}
                  <span>{catalogUrlSaved ? t('common.save') : t('settings.catalog_save_btn')}</span>
                </button>
              )}
            </div>
          )}
          {isCatalogSourceConfirming && (
            <span style={{ fontSize: '12px', color: '#ef4444', fontWeight: 600 }}>
              {t('settings.catalog_warn_custom')}
            </span>
          )}

          {syncFeedback && (
            <span style={{ fontSize: '12px', color: syncFeedback.includes('失败') ? '#ef4444' : '#10b981' }}>
              {syncFeedback}
            </span>
          )}
        </div>
      </div>

      <div className="settings-group">
        <div className={`settings-row ${highlightRow === 'export' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>{t('settings.export_apps')}</span>
              {activeNotice?.key === 'export' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-fluent btn-primary"
              onClick={handleExportJson}
              style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
              disabled={installedCount === 0}
            >
              <Download size={13} />
              <span>{t('settings.export_btn')}</span>
            </button>
          </div>
        </div>

        <DataBackupRow />
      </div>
    </div>
  );
};
