import React, { useState, useEffect, useRef } from 'react';
import {
  Settings,
  Monitor,
  Sun,
  Moon,
  Laptop,
  RotateCcw,
  Shield,
  Folder,
  FolderOpen,
  User,
  Globe,
  Zap,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  Check,
  Database,
  Download,
} from 'lucide-react';
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
  onResetSettings: () => Promise<void>;
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
  onResetSettings,
  installedCount,
  updateRulesCount,
  onOpenRules,
}) => {
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
  const [isResetConfirming, setIsResetConfirming] = useState(false);

  // Dynamic Animation & Micro-Feedback State
  const [activeNotice, setActiveNotice] = useState<{ key: string; text: string } | null>(null);
  const [highlightRow, setHighlightRow] = useState<string | null>(null);
  const [isResetWave, setIsResetWave] = useState(false);
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
      triggerChangeFeedback('catalog_sync', '✓ 开源软件收录库已同步最新');
      setTimeout(() => setSyncFeedback(null), 5000);
      window.dispatchEvent(new CustomEvent('zstore:catalog-synced'));
    } catch (e) {
      setSyncFeedback(`同步失败: ${String(e)}`);
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
          text: `${res.latency_ms} ms (连接正常)`,
          badge: '',
        });
      } else {
        setProxyTestResult({
          success: false,
          latency_ms: res.latency_ms,
          text: res.message || '连接超时 / 不可达',
          badge: '',
        });
      }
    } catch (e) {
      setProxyTestResult({
        success: false,
        latency_ms: 9999,
        text: '测速失败: ' + String(e),
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
      setProxySavedFeedback('✅ 已切换为 GitHub 官方直连模式');
      triggerChangeFeedback('proxy', '✓ 已切换为 GitHub 官方直连');
    } else {
      let finalUrl = trimmed;
      if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
        finalUrl = 'https://' + finalUrl;
        setProxyInput(finalUrl);
      }
      await onSelectMirror(finalUrl);
      onUpdateSetting('active_mirror', finalUrl);
      setProxySavedFeedback(`✅ 已成功启用下载加速代理: ${finalUrl}`);
      triggerChangeFeedback('proxy', '✓ 加速代理已配置生效');
    }
    setTimeout(() => setProxySavedFeedback(null), 3500);
  };



  const handleSelectTheme = (t: 'light' | 'dark' | 'system') => {
    const labelMap: Record<string, string> = {
      light: '明亮模式',
      dark: '暗黑模式',
      system: '跟随系统',
    };
    triggerChangeFeedback('theme', `✓ 已实时切换为${labelMap[t]}`);
    onSetTheme(t);
  };

  const handleSelectUiScale = (scale: '90' | '100' | '110' | '125') => {
    triggerChangeFeedback('ui_scale', `✓ 界面缩放已设为 ${scale}%`);
    onUpdateSetting('ui_scale', scale);
  };

  const handleSelectFontSize = (id: string, label: string) => {
    triggerChangeFeedback('font_size', `✓ 全局排版字号已设为 ${label}`);
    onUpdateSetting('font_size', id as any);
  };


  const handleSelectUpdateFrequency = (id: string, label: string) => {
    triggerChangeFeedback('update_frequency', `✓ 自动检查更新已设为: ${label}`);
    onUpdateSetting('update_frequency', id as any);
  };

  // FR-6.2: 关注更新的应用内提醒频率（每次启动 / 每天），经 user_settings 持久化
  const handleSelectWatchFrequency = (id: 'startup' | 'daily', label: string) => {
    triggerChangeFeedback('watch_notify_frequency', `✓ 关注提醒频率已设为: ${label}`);
    onUpdateSetting('watch_notify_frequency', id);
  };


  const handleExportJson = () => {
    onExportAppsJson();
    triggerChangeFeedback('export', '✓ 已导出软件资产 JSON 备份文件');
  };

  const handleExecuteResetSettings = async () => {
    setIsResetWave(true);
    triggerChangeFeedback('reset', '✓ 所有设置已恢复出厂默认状态');
    await onResetSettings();
    setIsResetConfirming(false);
    setTimeout(() => setIsResetWave(false), 1400);
  };

  return (
    <div className="settings-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">
          <Settings size={18} />
          <span>系统设置</span>
        </h3>
      </div>

      {/* 外观 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-0' : ''}`}>
        <div className="settings-group-title">
          <Monitor size={15} />
          <span>外观</span>
        </div>

        <div className={`settings-row ${highlightRow === 'theme' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>色彩主题模式</span>
              {activeNotice?.key === 'theme' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">明暗外观，可跟随系统</span>
          </div>
          <div className="segmented-group">
            <button
              className={`segmented-item ${currentTheme === 'light' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('light')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Sun size={13} />
              <span>明亮模式</span>
            </button>
            <button
              className={`segmented-item ${currentTheme === 'dark' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('dark')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Moon size={13} />
              <span>暗黑模式</span>
            </button>
            <button
              className={`segmented-item ${currentTheme === 'system' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('system')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Laptop size={13} />
              <span>跟随系统</span>
            </button>
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'ui_scale' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>界面缩放</span>
              {activeNotice?.key === 'ui_scale' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">自适应屏幕显示比例</span>
          </div>
          <div className="segmented-group">
            {(['90', '100', '110', '125'] as const).map((scale) => (
              <button
                key={scale}
                className={`segmented-item ${settings.ui_scale === scale ? 'active' : ''}`}
                onClick={() => handleSelectUiScale(scale)}
              >
                {scale}% {scale === '100' ? '(默认)' : ''}
              </button>
            ))}
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'font_size' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>字体大小</span>
              {activeNotice?.key === 'font_size' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">调整全局显示字号</span>
          </div>
          <div className="segmented-group">
            {[
              { id: '12', label: '12px' },
              { id: '14', label: '14px (默认)' },
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

      {/* 更新与提醒 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-1' : ''}`}>
        <div className="settings-group-title">
          <RotateCcw size={15} />
          <span>更新与提醒</span>
        </div>

        <div className={`settings-row ${highlightRow === 'update_frequency' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>自动检查更新频率</span>
              {activeNotice?.key === 'update_frequency' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">定期检查已安装软件的更新</span>
          </div>
          <div className="segmented-group">
            {[
              { id: 'startup', label: '启动时检测 (推荐)' },
              { id: 'daily', label: '每 24 小时轮询' },
              { id: 'manual', label: '仅手动检查' },
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
              <span style={{ fontWeight: 600 }}>关注应用提醒频率</span>
              {activeNotice?.key === 'watch_notify_frequency' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">关注应用发布新版本时的提醒频率</span>
          </div>
          <div className="segmented-group">
            {[
              { id: 'startup', label: '每次启动检查' },
              { id: 'daily', label: '每天汇总一次' },
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
            <span style={{ fontWeight: 600 }}>版本锁定与隐藏规则</span>
            <span className="settings-row-desc">
              {updateRulesCount > 0
                ? `已生效 ${updateRulesCount} 条规则`
                : '可在应用卡片菜单中配置跳过或锁定版本'}
            </span>
          </div>
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={onOpenRules}
            style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Shield size={13} />
            <span>规则</span>
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

      {/* 存储与下载 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-2' : ''}`}>
        <div className="settings-group-title">
          <Folder size={15} />
          <span>存储与下载</span>
        </div>

        <div
          className={`settings-row ${highlightRow === 'download_dir' ? 'row-highlight' : ''}`}
          style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
            }}
          >
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>安装包下载位置</span>
                {activeNotice?.key === 'download_dir' && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
              <span className="settings-row-desc">
                安装包默认下载保存位置
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
                onClick={async () => {
                  try {
                    const picked = await api.selectFolder(settings.download_dir, '选择安装包默认下载目录');
                    if (picked) {
                      onUpdateSetting('download_dir', picked);
                      triggerChangeFeedback('download_dir', `✓ 下载路径已设置为: ${picked}`);
                    }
                  } catch (e) {
                    console.error(e);
                  }
                }}
              >
                <FolderOpen size={13} />
                <span>浏览选择...</span>
              </button>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                onClick={() => {
                  onUpdateSetting('download_dir', '~/Downloads');
                  triggerChangeFeedback('download_dir', '✓ 已恢复默认位置 ~/Downloads');
                }}
              >
                <RotateCcw size={12} />
                <span>恢复默认</span>
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="text"
              className={`settings-input ${highlightRow === 'download_dir' ? 'input-highlight' : ''}`}
              value={settings.download_dir || '~/Downloads'}
              onChange={(e) => onUpdateSetting('download_dir', e.target.value)}
              placeholder="~/Downloads"
              style={{ flex: 1, fontSize: '12px', fontFamily: 'monospace' }}
            />
          </div>
        </div>

        <div
          className={`settings-row ${highlightRow === 'portable_dir' ? 'row-highlight' : ''}`}
          style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
            }}
          >
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>便携版解压目录</span>
                {activeNotice?.key === 'portable_dir' && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
              <span className="settings-row-desc">
                免安装绿色软件解压根目录
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
                onClick={async () => {
                  try {
                    const picked = await api.selectFolder(settings.portable_dir, '选择便携版解压目录');
                    if (picked) {
                      onUpdateSetting('portable_dir', picked);
                      triggerChangeFeedback('portable_dir', `✓ 便携版解压路径已设置为: ${picked}`);
                    }
                  } catch (e) {
                    console.error(e);
                  }
                }}
              >
                <FolderOpen size={13} />
                <span>浏览选择...</span>
              </button>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                onClick={() => {
                  const defaultPortable = '%LOCALAPPDATA%\\Programs\\z-store-apps';
                  onUpdateSetting('portable_dir', defaultPortable);
                  triggerChangeFeedback('portable_dir', '✓ 已恢复默认便携目录');
                }}
              >
                <RotateCcw size={12} />
                <span>恢复默认</span>
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="text"
              className={`settings-input ${highlightRow === 'portable_dir' ? 'input-highlight' : ''}`}
              value={settings.portable_dir || '%LOCALAPPDATA%\\Programs\\z-store-apps'}
              onChange={(e) => onUpdateSetting('portable_dir', e.target.value)}
              placeholder="%LOCALAPPDATA%\Programs\z-store-apps"
              style={{ flex: 1, fontSize: '12px', fontFamily: 'monospace' }}
            />
          </div>
        </div>
      </div>

      {/* 账号与配额 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-2' : ''}`}>
        <div className="settings-group-title">
          <User size={15} />
          <span>账号与配额</span>
        </div>

        <div id="settings-account">
          <OAuthAccountCard />
        </div>
      </div>

      {/* 网络与清单 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-3' : ''}`}>
        <div className="settings-group-title">
          <Globe size={15} />
          <span>网络与收录</span>
        </div>

        <div className={`settings-row ${highlightRow === 'proxy' ? 'row-highlight' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>GitHub 下载加速代理</span>
                {activeNotice?.key === 'proxy' && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
              <span className="settings-row-desc">
                留空为官方直连，可配置加速镜像地址
              </span>
            </div>
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
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input
              type="text"
              className={`settings-input ${highlightRow === 'proxy' ? 'input-highlight' : ''}`}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
              placeholder="留空为 GitHub 官方直连，或输入加速前缀如 https://gh-proxy.com"
            />
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 16px', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={handleTestProxy}
              disabled={isTestingProxy}
            >
              {isTestingProxy ? <RotateCcw size={12} className="icon-spin" /> : <Zap size={12} />}
              <span>{isTestingProxy ? '测速中...' : '测速'}</span>
            </button>
            <button
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 16px', whiteSpace: 'nowrap' }}
              onClick={handleSaveProxy}
            >
              保存
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '20px' }}>
            {proxySavedFeedback ? (
              <span style={{ fontSize: '12px', color: '#10b981', fontWeight: 500 }}>
                {proxySavedFeedback}
              </span>
            ) : (
              <span style={{ fontSize: '12px', color: 'var(--text-muted, #94a3b8)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>当前生效:</span>
                {(!proxyInput.trim() || proxyInput.trim() === 'direct') ? (
                  <>
                    <span className="status-dot status-dot-success" />
                    <span>GitHub 官方直连模式</span>
                  </>
                ) : (
                  <>
                    <Zap size={12} style={{ color: 'var(--brand-primary)' }} />
                    <span>自定义加速代理: {proxyInput.trim()}</span>
                  </>
                )}
              </span>
            )}
            {proxyInput.trim() && proxyInput.trim() !== 'direct' && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '11px', padding: '2px 8px', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={async () => {
                  setProxyInput('');
                  await onSelectMirror('direct');
                  onUpdateSetting('active_mirror', 'direct');
                  setProxySavedFeedback('已恢复 GitHub 官方直连');
                  triggerChangeFeedback('proxy', '✓ 已切换为 GitHub 官方直连');
                  setTimeout(() => setProxySavedFeedback(null), 3500);
                }}
              >
                <RotateCcw size={10} />
                <span>恢复直连</span>
              </button>
            )}
          </div>
        </div>

        <div className={`settings-row ${highlightRow === 'catalog_source' || highlightRow === 'catalog_sync' ? 'row-highlight' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>收录清单同步</span>
                {(activeNotice?.key === 'catalog_source' || activeNotice?.key === 'catalog_sync') && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
              <span className="settings-row-desc">
                从开源清单仓库同步最新收录数据
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => setShowAdvancedSource(!showAdvancedSource)}
              >
                {showAdvancedSource ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                <span>{showAdvancedSource ? '收起' : '自定义源'}</span>
              </button>
              <button
                type="button"
                className="btn-fluent btn-primary"
                onClick={handleSyncCatalog}
                disabled={isSyncingCatalog}
                style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                {isSyncingCatalog ? <RotateCcw size={12} className="icon-spin" /> : <RefreshCw size={12} />}
                <span>{isSyncingCatalog ? '同步中...' : '立即同步'}</span>
              </button>
            </div>
          </div>

          {showAdvancedSource && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--card-bg-subtle, rgba(255,255,255,0.03))',
                border: '1px dashed var(--border-color)',
              }}
            >
              <input
                type="text"
                className="settings-input"
                value={catalogSourceUrl}
                onChange={(e) => {
                  setCatalogSourceUrl(e.target.value);
                  setCatalogUrlSaved(false);
                }}
                placeholder="https://.../catalog.json"
                style={{ flex: 1, fontSize: '12px', fontFamily: 'monospace' }}
              />
              <button
                type="button"
                className="btn-fluent btn-primary"
                style={{ fontSize: '12px', padding: '5px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => {
                  onUpdateSetting('catalog_source_url', catalogSourceUrl.trim());
                  setCatalogUrlSaved(true);
                  triggerChangeFeedback('catalog_source', '✓ 收录清单源已保存更新');
                  setTimeout(() => setCatalogUrlSaved(false), 2500);
                }}
              >
                {catalogUrlSaved && <Check size={12} />}
                <span>{catalogUrlSaved ? '已保存' : '保存源'}</span>
              </button>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '5px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={async () => {
                  try {
                    const defUrl = await api.resetSetting('catalog_source_url');
                    setCatalogSourceUrl(defUrl);
                    onUpdateSetting('catalog_source_url', defUrl);
                    setCatalogUrlSaved(true);
                    triggerChangeFeedback('catalog_source', '✓ 已恢复官方默认收录源');
                    setTimeout(() => setCatalogUrlSaved(false), 2500);
                  } catch (err) {
                    console.error('Failed to reset catalog source URL:', err);
                  }
                }}
              >
                <RotateCcw size={12} />
                <span>恢复官方默认</span>
              </button>
            </div>
          )}

          {syncFeedback && (
            <span style={{ fontSize: '12px', color: syncFeedback.includes('失败') ? '#ef4444' : '#10b981' }}>
              {syncFeedback}
            </span>
          )}
        </div>
      </div>

      {/* 数据备份 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-4' : ''}`}>
        <div className="settings-group-title">
          <Database size={15} />
          <span>数据备份</span>
        </div>

        <div className={`settings-row ${highlightRow === 'export' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>已管理应用导出</span>
              {activeNotice?.key === 'export' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">
              {typeof installedCount === 'number' && installedCount > 0
                ? `已管理 ${installedCount} 款软件，可导出为 JSON 备份`
                : '导出已安装软件清单为 JSON 备份文件'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-fluent btn-primary"
              onClick={handleExportJson}
              style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
              disabled={installedCount === 0}
            >
              <Download size={13} />
              <span>导出清单</span>
            </button>
          </div>
        </div>

        <DataBackupRow />

        <div className={`settings-row ${highlightRow === 'reset' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>恢复默认设置</span>
              {activeNotice?.key === 'reset' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">将所有设置恢复为默认值</span>
          </div>
          {isResetConfirming ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: '#ef4444', fontWeight: 600 }}>确定重置所有设置？</span>
              <button
                className="btn-fluent"
                style={{
                  padding: '6px 14px',
                  fontSize: '12px',
                  background: '#ef4444',
                  color: '#fff',
                  fontWeight: 600,
                }}
                onClick={handleExecuteResetSettings}
              >
                确认重置
              </button>
              <button
                className="btn-fluent btn-secondary"
                style={{ padding: '6px 10px', fontSize: '12px' }}
                onClick={() => setIsResetConfirming(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={() => setIsResetConfirming(true)}
            >
              <RotateCcw size={13} />
              <span>恢复默认</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
