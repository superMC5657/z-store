import React, { useState, useEffect, useRef } from 'react';
import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppSettings } from '../types';
import { tauriApi } from '../services/api';
import { ViewShell } from './ViewShell';
import { AppearanceSection } from './SettingsView/sections/AppearanceSection';
import { getPendingShowCoordsPref, setPendingShowCoordsPref } from '../lib/pendingPrefs';
import { UpdatesRulesSection } from './SettingsView/sections/UpdatesRulesSection';
import { StorageSection } from './SettingsView/sections/StorageSection';
import { NetworkDataSection } from './SettingsView/sections/NetworkDataSection';
import { DataManagementSection } from './SettingsView/sections/DataManagementSection';

interface SettingsViewProps {
  onSelectMirror: (id: string) => void;
  theme: 'light' | 'dark' | 'system';
  onSetTheme: (theme: 'light' | 'dark' | 'system') => void;
  onExportAppsJson: () => void;
  settings: AppSettings;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  installedCount: number;
  updateRulesCount: number;
  onOpenRules: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  onSelectMirror,
  theme,
  onSetTheme,
  onExportAppsJson,
  settings,
  onUpdateSetting,
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
    settings.catalog_source_url || ''
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
      const res = await tauriApi.syncCatalog(true);
      setSyncFeedback(res.message);
      triggerChangeFeedback('catalog_sync', t('settings.catalog_sync_success'));
      setTimeout(() => setSyncFeedback(null), 5000);
      window.dispatchEvent(new CustomEvent('zstore:catalog-synced'));
      // 同步可能触发转正归档：通知 customApps 重载，待收录页/计数立即跟随（无需重启）。
      window.dispatchEvent(new CustomEvent('zstore:custom-apps-changed'));
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
      const res = await tauriApi.testProxy(url || undefined);
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
    try {
      if (!trimmed || trimmed === 'direct') {
        await onSelectMirror('direct');
        onUpdateSetting('active_mirror', 'direct');
        setProxySavedFeedback(t('settings.proxy_saved_direct'));
        triggerChangeFeedback('proxy', t('settings.proxy_active_direct'));
      } else {
        let finalUrl = trimmed;
        if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
          finalUrl = 'https://' + finalUrl;
          setProxyInput(finalUrl);
        }
        await onSelectMirror(finalUrl);
        onUpdateSetting('active_mirror', finalUrl);
        setProxySavedFeedback(t('settings.proxy_saved_custom', { url: finalUrl }));
        triggerChangeFeedback('proxy', t('settings.save_proxy'));
      }
      setTimeout(() => setProxySavedFeedback(null), 3500);
    } catch (e) {
      // 切换镜像失败：不落 active_mirror、不给成功反馈，错误留存至下次操作
      setProxySavedFeedback(t('settings.proxy_save_failed', { error: String(e) }));
    }
  };



  const handleSelectTheme = (themeMode: 'light' | 'dark' | 'system') => {
    const labelMap: Record<string, string> = {
      light: t('settings.theme_light'),
      dark: t('settings.theme_dark'),
      system: t('settings.theme_system'),
    };
    triggerChangeFeedback('theme', labelMap[themeMode]);
    onSetTheme(themeMode);
  };

  const handleSelectLanguage = (lng: 'zh-CN' | 'en-US') => {
    triggerChangeFeedback('language', lng === 'zh-CN' ? '简体中文' : 'English');
    onUpdateSetting('language', lng);
  };

  const handleSelectUiScale = (scale: '90' | '100' | '110' | '125') => {
    triggerChangeFeedback('ui_scale', `${scale}%`);
    onUpdateSetting('ui_scale', scale);
  };

  const handleSelectFontSize = (id: AppSettings['font_size'], label: string) => {
    triggerChangeFeedback('font_size', label);
    onUpdateSetting('font_size', id);
  };


  const handleSelectUpdateFrequency = (id: AppSettings['update_frequency'], label: string) => {
    triggerChangeFeedback('update_frequency', label);
    onUpdateSetting('update_frequency', id);
  };

  // FR-6.2: 关注更新的应用内提醒频率（每次启动 / 每天），经 user_settings 持久化
  const handleSelectWatchFrequency = (id: 'startup' | 'daily', label: string) => {
    triggerChangeFeedback('watch_notify_frequency', label);
    onUpdateSetting('watch_notify_frequency', id);
  };


  const handleExportJson = () => {
    onExportAppsJson();
    triggerChangeFeedback('export', t('settings.export_apps'));
  };

  // 信任阻尼：切换至非默认（自定义）收录源将替换受信任的目录，
  // 属于敏感破坏性操作，必须经过二次显式确认。保存为空值（即恢复官方默认源流）立即生效。
  const stagedCatalogUrl = catalogSourceUrl.trim();
  const isCustomCatalogSourceChange =
    stagedCatalogUrl.length > 0 && stagedCatalogUrl !== (settings.catalog_source_url || '').trim();

  const handleSaveCatalogSource = () => {
    if (isCustomCatalogSourceChange && !isCatalogSourceConfirming) {
      setIsCatalogSourceConfirming(true);
      return;
    }
    onUpdateSetting('catalog_source_url', stagedCatalogUrl);
    setIsCatalogSourceConfirming(false);
    setCatalogUrlSaved(true);
    triggerChangeFeedback('catalog_source', t('settings.catalog_sync_title'));
    setTimeout(() => setCatalogUrlSaved(false), 2500);
  };

  // 待收录草稿仓库与标识显隐（统一命名 showCoords；文案键沿用 settings.pending_coords_*）
  const [showCoords, setShowCoords] = useState<boolean>(() => getPendingShowCoordsPref());

  const handleToggleShowCoords = (show: boolean) => {
    setPendingShowCoordsPref(show);
    setShowCoords(show);
    triggerChangeFeedback('pending_coords', show ? t('settings.pending_coords_shown') : t('settings.pending_coords_hidden'));
  };

  return (
    <ViewShell viewClass="settings-view">
      <div className="section-header">
        <h3 className="section-title">
          <Settings size={16} strokeWidth={1.5} />
          <span>{t('settings.title')}</span>
        </h3>
      </div>

      <AppearanceSection
        currentTheme={currentTheme}
        language={settings.language}
        uiScale={settings.ui_scale}
        fontSize={settings.font_size}
        highlightRow={highlightRow}
        activeNotice={activeNotice}
        onSelectTheme={handleSelectTheme}
        onSelectLanguage={handleSelectLanguage}
        onSelectUiScale={handleSelectUiScale}
        onSelectFontSize={handleSelectFontSize}
        showCoords={showCoords}
        onToggleShowCoords={handleToggleShowCoords}
      />

      <UpdatesRulesSection
        updateFrequency={settings.update_frequency}
        watchNotifyFrequency={settings.watch_notify_frequency}
        updateRulesCount={updateRulesCount}
        highlightRow={highlightRow}
        activeNotice={activeNotice}
        onSelectUpdateFrequency={handleSelectUpdateFrequency}
        onSelectWatchFrequency={handleSelectWatchFrequency}
        onOpenRules={onOpenRules}
      />

      <StorageSection
        downloadDir={settings.download_dir}
        portableDir={settings.portable_dir}
        highlightRow={highlightRow}
        activeNotice={activeNotice}
        onUpdateSetting={onUpdateSetting}
        triggerChangeFeedback={triggerChangeFeedback}
      />

      <NetworkDataSection
        proxyInput={proxyInput}
        setProxyInput={setProxyInput}
        isTestingProxy={isTestingProxy}
        proxyTestResult={proxyTestResult}
        proxySavedFeedback={proxySavedFeedback}
        highlightRow={highlightRow}
        activeNotice={activeNotice}
        handleTestProxy={handleTestProxy}
        handleSaveProxy={handleSaveProxy}
        catalogSourceUrl={catalogSourceUrl}
        setCatalogSourceUrl={setCatalogSourceUrl}
        setCatalogUrlSaved={setCatalogUrlSaved}
        isSyncingCatalog={isSyncingCatalog}
        syncFeedback={syncFeedback}
        showAdvancedSource={showAdvancedSource}
        setShowAdvancedSource={setShowAdvancedSource}
        isCatalogSourceConfirming={isCatalogSourceConfirming}
        setIsCatalogSourceConfirming={setIsCatalogSourceConfirming}
        handleSyncCatalog={handleSyncCatalog}
        handleSaveCatalogSource={handleSaveCatalogSource}
        catalogUrlSaved={catalogUrlSaved}
      />

      <DataManagementSection
        installedCount={installedCount}
        highlightRow={highlightRow}
        activeNotice={activeNotice}
        handleExportJson={handleExportJson}
      />
    </ViewShell>
  );
};
