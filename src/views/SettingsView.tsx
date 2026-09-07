import React, { useState, useEffect, useRef } from 'react';
import { AppSettings, HostRateLimitStatus, HostTokenEntry, MirrorNodeStatus } from '../types';
import { api } from '../services/api';

interface SettingsViewProps {
  mirrors: MirrorNodeStatus[];
  onSelectMirror: (id: string) => void;
  onPingMirrors: () => void;
  theme: 'light' | 'dark' | 'system';
  onSetTheme: (theme: 'light' | 'dark' | 'system') => void;
  onSaveToken: (token: string) => Promise<void>;
  onExportApps: () => void;
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
  theme: _theme,
  onSetTheme,
  onSaveToken,
  onExportApps,
  onExportAppsJson,
  settings,
  onUpdateSetting,
  onResetSettings,
  installedCount: _installedCount,
  updateRulesCount,
  onOpenRules,
}) => {
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
  const DEFAULT_CATALOG_URL = 'https://gh-proxy.com/https://raw.githubusercontent.com/supermc/z-store/main/src-tauri/src/catalog.json';
  const [catalogSourceUrl, setCatalogSourceUrl] = useState(
    settings.catalog_source_url && !settings.catalog_source_url.includes('gitmirror.com')
      ? settings.catalog_source_url
      : DEFAULT_CATALOG_URL
  );
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

  // GitHub PAT & API Quota State
  const [hostTokens, setHostTokens] = useState<HostTokenEntry[]>([]);
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});
  const [hostStatus, setHostStatus] = useState<Record<string, HostRateLimitStatus>>({});
  const [isTestingHost, setIsTestingHost] = useState<Record<string, boolean>>({});
  const [hostFeedback, setHostFeedback] = useState<string | null>(null);
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

  const loadHostTokens = async () => {
    try {
      const tokens = await api.getHostTokens();
      setHostTokens(tokens);
      const inputs: Record<string, string> = {};
      tokens.forEach((t) => {
        inputs[t.host] = t.token;
      });
      if (!inputs['github.com'] && settings.github_token) {
        inputs['github.com'] = settings.github_token;
      }
      setTokenInputs((prev) => ({ ...inputs, ...prev }));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadHostTokens();
    let isMounted = true;
    let unlistenFn: (() => void) | null = null;
    api.onQuotaUpdated(() => {
      if (isMounted) {
        loadHostTokens();
      }
    }).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    });

    return () => {
      isMounted = false;
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [settings.github_token]);

  useEffect(() => {
    if (settings.catalog_source_url) {
      if (settings.catalog_source_url.includes('gitmirror.com')) {
        setCatalogSourceUrl(DEFAULT_CATALOG_URL);
      } else {
        setCatalogSourceUrl(settings.catalog_source_url);
      }
    }
  }, [settings.catalog_source_url]);

  const handleSaveHostToken = async (host: string) => {
    const val = tokenInputs[host] || '';
    try {
      await api.setHostToken(host, val);
      if (host.toLowerCase() === 'github.com') {
        await onSaveToken(val);
      }
      setHostFeedback(`✅ 已保存 ${host} 的访问令牌`);
      triggerChangeFeedback('token', val ? '✓ 访问令牌已更新生效' : '✓ 访问令牌已清空');
      setTimeout(() => setHostFeedback(null), 3000);
      loadHostTokens();
      window.dispatchEvent(new CustomEvent('zstore:quota-updated'));
    } catch (e) {
      setHostFeedback(`❌ 保存失败: ${String(e)}`);
    }
  };

  const handleTestHost = async (host: string) => {
    const val = tokenInputs[host] || '';
    setIsTestingHost((prev) => ({ ...prev, [host]: true }));
    try {
      const status = await api.testHostConnection(host, val);
      setHostStatus((prev) => ({ ...prev, [host]: status }));
      window.dispatchEvent(new CustomEvent('zstore:quota-updated'));
    } catch (e) {
      setHostStatus((prev) => ({
        ...prev,
        [host]: { host, is_connected: false, message: String(e) },
      }));
    } finally {
      setIsTestingHost((prev) => ({ ...prev, [host]: false }));
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
        let badge = '🟢';
        if (res.latency_ms >= 1000) badge = '🟠';
        else if (res.latency_ms >= 400) badge = '🟡';
        setProxyTestResult({
          success: true,
          latency_ms: res.latency_ms,
          text: `${res.latency_ms} ms (连接正常)`,
          badge,
        });
      } else {
        setProxyTestResult({
          success: false,
          latency_ms: res.latency_ms,
          text: res.message || '连接超时 / 不可达',
          badge: '🔴',
        });
      }
    } catch (e) {
      setProxyTestResult({
        success: false,
        latency_ms: 9999,
        text: '测速失败: ' + String(e),
        badge: '🔴',
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

  // 应用详情缓存生存时效 (TTL, ADR-0007)：恰好六档，键名 detail_cache_ttl_minutes，默认 30 分钟
  const TTL_OPTIONS: { value: number; label: string }[] = [
    { value: 0, label: '0 分钟（实时校验）' },
    { value: 10, label: '10 分钟' },
    { value: 30, label: '30 分钟（默认推荐）' },
    { value: 60, label: '1 小时' },
    { value: 360, label: '6 小时' },
    { value: 1440, label: '24 小时' },
  ];

  const handleSelectTtl = (minutes: number, label: string) => {
    triggerChangeFeedback('detail_cache_ttl_minutes', `✓ 详情缓存生存时效已设为 ${label}`);
    onUpdateSetting('detail_cache_ttl_minutes', minutes);
  };

  const handleExportMarkdown = () => {
    onExportApps();
    triggerChangeFeedback('export', '✓ 已复制 Markdown 清单到剪贴板');
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
        <h3 className="section-title">⚙️ 系统设置与个性化控制中枢</h3>
      </div>

      {/* Group 1: Display, Resolution & Accessibility */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-0' : ''}`}>
        <div className="settings-group-title">🖥️ 视窗、显示与无障碍</div>

        {/* 1.1 Theme Mode */}
        <div className={`settings-row ${highlightRow === 'theme' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>色彩主题模式</span>
              {activeNotice?.key === 'theme' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">选择 Fluent Design 2.0 视觉明暗基调，支持跟随系统明暗设置</span>
          </div>
          <div className="segmented-group">
            <button
              className={`segmented-item ${settings.theme === 'light' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('light')}
            >
              ☀️ 明亮模式
            </button>
            <button
              className={`segmented-item ${settings.theme === 'dark' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('dark')}
            >
              🌙 暗黑模式
            </button>
            <button
              className={`segmented-item ${settings.theme === 'system' ? 'active' : ''}`}
              onClick={() => handleSelectTheme('system')}
            >
              💻 跟随系统
            </button>
          </div>
        </div>

        {/* 1.2 UI Scale */}
        <div className={`settings-row ${highlightRow === 'ui_scale' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>界面整体缩放比例 (UI Zoom)</span>
              {activeNotice?.key === 'ui_scale' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">自适应高 DPI 屏幕与显示器缩放比例</span>
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

        {/* 1.3 Font Size */}
        {/* 1.3 Font Size (User specified: 12, 14, 16, 18, 20 with step of 2) */}
        <div className={`settings-row ${highlightRow === 'font_size' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>全局排版字号大小 (Font Size)</span>
              {activeNotice?.key === 'font_size' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">以 2px 为步长微调全界面排版文字大小，兼顾信息密集与阅读舒适</span>
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

      {/* Group 2: Storage & Manifest Lifecycle */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-1' : ''}`}>
        <div className="settings-group-title">📂 清单同步与数据存储</div>

        {/* 2.2 Catalog Manifest Sync (With advanced source fold) */}
        <div className={`settings-row ${highlightRow === 'catalog_source' || highlightRow === 'catalog_sync' ? 'row-highlight' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>开源收录清单动态同步</span>
                {(activeNotice?.key === 'catalog_source' || activeNotice?.key === 'catalog_sync') && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
              <span className="settings-row-desc">
                收录应用由社区开源清单仓库维护，随时检查并拉取最新上架开源软件清单
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 12px' }}
                onClick={() => setShowAdvancedSource(!showAdvancedSource)}
              >
                {showAdvancedSource ? '收起配置 ▲' : '高级源配置 ▼'}
              </button>
              <button
                type="button"
                className="btn-fluent btn-primary"
                onClick={handleSyncCatalog}
                disabled={isSyncingCatalog}
                style={{ fontSize: '12px', padding: '6px 14px' }}
              >
                {isSyncingCatalog ? '🔄 正在同步...' : '🔄 立即同步收录库'}
              </button>
            </div>
          </div>

          {/* Advanced source URL collapsible section */}
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
                style={{ fontSize: '12px', padding: '5px 12px' }}
                onClick={() => {
                  onUpdateSetting('catalog_source_url', catalogSourceUrl.trim());
                  setCatalogUrlSaved(true);
                  triggerChangeFeedback('catalog_source', '✓ 收录清单源已保存更新');
                  setTimeout(() => setCatalogUrlSaved(false), 2500);
                }}
              >
                {catalogUrlSaved ? '✓ 已保存' : '保存源'}
              </button>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '5px 12px' }}
                onClick={() => {
                  const defUrl = 'https://gh-proxy.com/https://raw.githubusercontent.com/supermc/z-store/main/src-tauri/src/catalog.json';
                  setCatalogSourceUrl(defUrl);
                  onUpdateSetting('catalog_source_url', defUrl);
                  setCatalogUrlSaved(true);
                  triggerChangeFeedback('catalog_source', '✓ 已恢复官方默认收录源');
                  setTimeout(() => setCatalogUrlSaved(false), 2500);
                }}
              >
                恢复官方默认
              </button>
            </div>
          )}

          {syncFeedback && (
            <span style={{ fontSize: '12px', color: syncFeedback.includes('失败') ? '#ef4444' : '#10b981' }}>
              {syncFeedback}
            </span>
          )}
        </div>

        {/* 2.3 Detail Cache TTL (ADR-0007: exactly six gears, key detail_cache_ttl_minutes) */}
        <div className={`settings-row ${highlightRow === 'detail_cache_ttl_minutes' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>应用详情缓存生存时效 (TTL)</span>
              {activeNotice?.key === 'detail_cache_ttl_minutes' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">
              保鲜期内重复打开直接读取本地缓存（0ms 秒开）；超过时效自动发起 ETag 条件重新验证，离线时回退历史缓存
            </span>
          </div>
          <div className="segmented-group">
            {TTL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`segmented-item ${settings.detail_cache_ttl_minutes === opt.value ? 'active' : ''}`}
                onClick={() => handleSelectTtl(opt.value, opt.label)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Group 3: Network & GitHub API Quota */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-2' : ''}`}>
        <div className="settings-group-title">🌐 网络设置与 GitHub API 配额</div>

        {/* 3.1 Download Acceleration Proxy Configuration */}
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
                默认为 GitHub 官方直连。国内网络如遇下载缓慢，可指定加速代理前缀（如 <code>https://gh-proxy.com</code>），留空即为官方直连
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
                  gap: '4px',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{proxyTestResult.badge}</span>
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
              style={{ fontSize: '12px', padding: '6px 16px', whiteSpace: 'nowrap' }}
              onClick={handleTestProxy}
              disabled={isTestingProxy}
            >
              {isTestingProxy ? '⚡ 正在测速...' : '⚡ 单击测速'}
            </button>
            <button
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 16px', whiteSpace: 'nowrap' }}
              onClick={handleSaveProxy}
            >
              保存配置
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '20px' }}>
            {proxySavedFeedback ? (
              <span style={{ fontSize: '12px', color: '#10b981', fontWeight: 500 }}>
                {proxySavedFeedback}
              </span>
            ) : (
              <span style={{ fontSize: '12px', color: 'var(--text-muted, #94a3b8)' }}>
                当前生效: {(!proxyInput.trim() || proxyInput.trim() === 'direct') ? '🟢 GitHub 官方直连模式' : `⚡ 自定义加速代理: ${proxyInput.trim()}`}
              </span>
            )}
          </div>
        </div>

        {/* 3.3 GitHub Personal Access Token & API Quota */}
        <div className={`settings-row ${highlightRow === 'token' ? 'row-highlight' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>🐙 GitHub 个人访问令牌 (Personal Access Token)</span>
                {activeNotice?.key === 'token' && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
              <span className="settings-row-desc">
                默认匿名公共 IP 共享每小时 60 次 API 配额；配置个人令牌（仅需公开只读权限）可立即提升至 5,000 次/小时
              </span>
            </div>
            {hostStatus['github.com'] && (
              <span
                style={{
                  fontSize: '11px',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  background: hostStatus['github.com'].is_connected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: hostStatus['github.com'].is_connected ? '#10b981' : '#ef4444',
                  border: `1px solid ${hostStatus['github.com'].is_connected ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontWeight: 500,
                }}
              >
                {hostStatus['github.com'].is_connected ? '🟢' : '🔴'}{' '}
                {hostStatus['github.com'].message ||
                  (hostStatus['github.com'].is_connected
                    ? `配额剩余: ${hostStatus['github.com'].rate_limit_remaining ?? '充裕'}`
                    : '连接失败')}
              </span>
            )}
          </div>

          {hostFeedback && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: '6px',
                background: 'rgba(56, 189, 248, 0.1)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                fontSize: '12px',
                color: 'var(--brand-primary)',
              }}
            >
              {hostFeedback}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              padding: '14px',
              borderRadius: '8px',
              background: 'var(--card-bg-subtle, rgba(255,255,255,0.02))',
              border: '1px solid var(--border-color)',
            }}
          >
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: '1 1 280px' }}>
                <input
                  type={showTokens['github.com'] ? 'text' : 'password'}
                  placeholder="ghp_xxxxxxxxxxxx (无需勾选敏感权限，公开只读即可)"
                  value={
                    tokenInputs['github.com'] !== undefined
                      ? tokenInputs['github.com']
                      : hostTokens.find((t) => t.host === 'github.com')?.token || ''
                  }
                  onChange={(e) => setTokenInputs({ ...tokenInputs, 'github.com': e.target.value })}
                  className={`settings-input ${highlightRow === 'token' ? 'input-highlight' : ''}`}
                  style={{ width: '100%', paddingRight: '32px' }}
                />
                <button
                  type="button"
                  onClick={() => setShowTokens({ ...showTokens, 'github.com': !showTokens['github.com'] })}
                  style={{
                    position: 'absolute',
                    right: '6px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-tertiary)',
                    fontSize: '12px',
                  }}
                  title={showTokens['github.com'] ? '隐藏凭据' : '显示凭据'}
                >
                  {showTokens['github.com'] ? '🙈' : '👁️'}
                </button>
              </div>

              <button
                type="button"
                className="btn-fluent btn-primary"
                style={{ fontSize: '12px', padding: '6px 16px' }}
                onClick={() => handleSaveHostToken('github.com')}
              >
                保存令牌
              </button>

              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 14px' }}
                disabled={!!isTestingHost['github.com']}
                onClick={() => handleTestHost('github.com')}
              >
                {isTestingHost['github.com'] ? '正在探测...' : '测试连通性'}
              </button>
            </div>

            <div
              style={{
                fontSize: '11px',
                color: 'var(--text-tertiary)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '6px',
              }}
            >
              <span>💡 提示：前往 GitHub 官网 -&gt; Settings -&gt; Developer Settings -&gt; Personal access tokens 生成</span>
              {(tokenInputs['github.com'] || hostTokens.find((t) => t.host === 'github.com')?.token) && (
                <button
                  type="button"
                  className="btn-fluent btn-secondary"
                  style={{ fontSize: '11px', padding: '2px 8px', color: '#ef4444' }}
                  onClick={async () => {
                    setTokenInputs((prev) => ({ ...prev, 'github.com': '' }));
                    await handleSaveHostToken('github.com');
                  }}
                >
                  清空令牌
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 3.3 Update Frequency */}
        <div className={`settings-row ${highlightRow === 'update_frequency' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>自动检查更新频率</span>
              {activeNotice?.key === 'update_frequency' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">基于 GitHub Releases ETag 机制智能探测已纳管软件版本</span>
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
      </div>

      {/* Group 4: Update Policies & Rules Center */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-3' : ''}`}>
        <div className="settings-group-title">🛡️ 版本策略与软件屏蔽规则</div>
        <div className="settings-row" style={{ alignItems: 'center' }}>
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>更新忽略、版本锁定与全局隐藏规则</span>
            <span className="settings-row-desc">
              {updateRulesCount > 0
                ? `当前已生效 ${updateRulesCount} 条规则。支持随时解除版本锁定、恢复忽略的版本更新提醒或取消隐藏。`
                : '当前未配置任何版本屏蔽规则。在「更新中心」应用卡片右侧菜单可快速配置版本跳过或锁定。'}
            </span>
          </div>
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={onOpenRules}
            style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <span>🛡️ 规则</span>
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

      {/* Group 5: Data & Factory Reset */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-4' : ''}`}>
        <div className="settings-group-title">📊 软件资产与恢复出厂设置</div>

        {/* 6.1 Export Assets */}
        <div className={`settings-row ${highlightRow === 'export' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>软件资产清单双格式导出</span>
              {activeNotice?.key === 'export' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">生成标准 Markdown 资产报告或 JSON 结构化备份，便于换机一键装机</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-fluent btn-secondary"
              onClick={handleExportMarkdown}
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              📋 导出 Markdown 清单
            </button>
            <button
              className="btn-fluent btn-primary"
              onClick={handleExportJson}
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              💾 导出 JSON 备份文件
            </button>
          </div>
        </div>

        {/* 6.2 Reset to Defaults */}
        <div className={`settings-row ${highlightRow === 'reset' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>恢复出厂默认设置</span>
              {activeNotice?.key === 'reset' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">将视窗分辨率、缩放比、字体大小及网络参数恢复至初始状态</span>
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
              style={{ fontSize: '12px', padding: '6px 14px', color: '#ef4444' }}
              onClick={() => setIsResetConfirming(true)}
            >
              🔄 恢复出厂设置
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
