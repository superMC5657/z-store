import React, { useState, useEffect, useRef } from 'react';
import { AppSettings, HostRateLimitStatus, HostTokenEntry, MirrorNodeStatus } from '../types';
import { api } from '../services/api';
import { ClientUpdateRow } from '../components/ClientUpdateRow';
import { OAuthAccountCard } from '../components/OAuthAccountCard';
import { DataBackupRow } from '../components/DataBackupRow';

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
  mirrors,
  onSelectMirror,
  onPingMirrors,
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
  // 出站代理（登录与 API 直连共用；区别于上面的下载加速前缀）
  const [fwdProxyInput, setFwdProxyInput] = useState('');
  const [isTestingFwdProxy, setIsTestingFwdProxy] = useState(false);
  const [fwdProxyResult, setFwdProxyResult] = useState<{
    success: boolean;
    latency_ms: number;
    message: string;
  } | null>(null);
  const [fwdProxyFeedback, setFwdProxyFeedback] = useState<string | null>(null);
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

  // 出站代理：预填已保存值
  useEffect(() => {
    api.getSettings().then((s) => {
      const v = s['http_proxy_url'];
      if (typeof v === 'string' && v.trim()) {
        setFwdProxyInput(v.trim());
      }
    }).catch(() => {
      // ignore：保持留空直连
    });
  }, []);

  const handleTestFwdProxy = async () => {
    setIsTestingFwdProxy(true);
    setFwdProxyResult(null);
    try {
      const res = await api.testForwardProxy(fwdProxyInput.trim());
      setFwdProxyResult(res);
    } catch (e) {
      setFwdProxyResult({
        success: false,
        latency_ms: 0,
        message: '测试失败: ' + String(e),
      });
    } finally {
      setIsTestingFwdProxy(false);
    }
  };

  const handleSaveFwdProxy = async () => {
    try {
      await api.setForwardProxy(fwdProxyInput.trim());
      const cleared = !fwdProxyInput.trim();
      setFwdProxyFeedback(cleared ? '✅ 已清空出站代理，回退系统代理/直连' : '✅ 出站代理已保存并即时生效（登录与 API）');
      triggerChangeFeedback('forward_proxy', cleared ? '✓ 出站代理已清空' : '✓ 出站代理已生效');
    } catch (e) {
      setFwdProxyFeedback('❌ 保存失败: ' + String(e));
    }
    setTimeout(() => setFwdProxyFeedback(null), 3500);
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
        <h3 className="section-title">⚙️ 系统设置</h3>
      </div>

      {/* 外观 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-0' : ''}`}>
        <div className="settings-group-title">🖥️ 外观与显示</div>

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

        <div className={`settings-row ${highlightRow === 'font_size' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>全局排版字号大小 (Font Size)</span>
              {activeNotice?.key === 'font_size' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">步长 2px</span>
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
        <div className="settings-group-title">🔄 更新与提醒</div>

        <div className={`settings-row ${highlightRow === 'update_frequency' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>自动检查更新频率</span>
              {activeNotice?.key === 'update_frequency' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">用 ETag 探测已纳管软件的新版本</span>
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
              <span style={{ fontWeight: 600 }}>关注应用的更新提醒频率</span>
              {activeNotice?.key === 'watch_notify_frequency' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">关注应用发新版时的提醒节奏</span>
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
                ? `已生效 ${updateRulesCount} 条，可随时解除锁定、恢复提醒或取消隐藏。`
                : '在「更新中心」卡片菜单可配置跳过或锁定版本。'}
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

      {/* 账号与配额 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-2' : ''}`}>
        <div className="settings-group-title">👤 GitHub 账号与配额</div>

        <div id="settings-account">
          <OAuthAccountCard />
        </div>

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
                匿名 60 次/小时；配置令牌（公开只读即可）提升至 5,000 次/小时
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
              <span>💡 前往 GitHub Settings → Developer Settings 生成</span>
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
      </div>

      {/* 网络与清单 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-3' : ''}`}>
        <div className="settings-group-title">🌐 网络与清单数据</div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>加速节点切换</span>
            <span className="settings-row-desc">当前下载走的镜像节点</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="segmented-group">
              {mirrors.map((m) => (
                <button
                  key={m.id}
                  className={`segmented-item ${m.is_active ? 'active' : ''}`}
                  onClick={() => onSelectMirror(m.id)}
                  title={m.base_url || m.id}
                >
                  {m.name}
                </button>
              ))}
            </div>
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px', whiteSpace: 'nowrap' }}
              onClick={onPingMirrors}
            >
              ⚡ 测速
            </button>
          </div>
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
                留空为官方直连；国内下载慢可填加速前缀
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

        <div className={`settings-row ${highlightRow === 'forward_proxy' ? 'row-highlight' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="settings-row-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>🌐 出站代理（登录与 API）</span>
                {activeNotice?.key === 'forward_proxy' && (
                  <span className="setting-applied-badge">{activeNotice.text}</span>
                )}
              </div>
              <span className="settings-row-desc">
                留空为直连/跟随系统代理；github.com 连不通（如登录轮询失败）时填，保存即时生效
              </span>
            </div>
            {fwdProxyResult && (
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: !fwdProxyResult.success ? '#ef4444' : fwdProxyResult.latency_ms < 400 ? '#10b981' : fwdProxyResult.latency_ms < 1000 ? '#f59e0b' : '#ea580c',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{fwdProxyResult.success ? '🟢' : '🔴'}</span>
                <span>{fwdProxyResult.message}</span>
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input
              type="text"
              className={`settings-input ${highlightRow === 'forward_proxy' ? 'input-highlight' : ''}`}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
              value={fwdProxyInput}
              onChange={(e) => setFwdProxyInput(e.target.value)}
              placeholder="如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890"
            />
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 16px', whiteSpace: 'nowrap' }}
              onClick={handleTestFwdProxy}
              disabled={isTestingFwdProxy}
            >
              {isTestingFwdProxy ? '正在测试...' : '测试连通性'}
            </button>
            <button
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 16px', whiteSpace: 'nowrap' }}
              onClick={handleSaveFwdProxy}
            >
              保存配置
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '20px' }}>
            {fwdProxyFeedback ? (
              <span style={{ fontSize: '12px', color: '#10b981', fontWeight: 500 }}>
                {fwdProxyFeedback}
              </span>
            ) : (
              <span style={{ fontSize: '12px', color: 'var(--text-muted, #94a3b8)' }}>
                当前生效: {!fwdProxyInput.trim() ? '🟢 直连 / 跟随系统代理' : `🌐 出站代理: ${fwdProxyInput.trim()}`}
              </span>
            )}
            {fwdProxyInput.trim() && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '11px', padding: '2px 8px', color: '#ef4444' }}
                onClick={async () => {
                  setFwdProxyInput('');
                  try {
                    await api.setForwardProxy('');
                    setFwdProxyFeedback('✅ 已清空出站代理，回退系统代理/直连');
                    triggerChangeFeedback('forward_proxy', '✓ 出站代理已清空');
                  } catch (e) {
                    setFwdProxyFeedback('❌ 清空失败: ' + String(e));
                  }
                  setTimeout(() => setFwdProxyFeedback(null), 3500);
                }}
              >
                清空代理
              </button>
            )}
          </div>
        </div>

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
                从社区开源清单仓库拉取最新收录
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

        <div className={`settings-row ${highlightRow === 'detail_cache_ttl_minutes' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>应用详情缓存生存时效 (TTL)</span>
              {activeNotice?.key === 'detail_cache_ttl_minutes' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">
              有效期内直接读本地缓存；过期自动 ETag 验证，离线回退缓存
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

      {/* 数据备份与恢复 */}
      <div className={`settings-group ${isResetWave ? 'reset-wave-4' : ''}`}>
        <div className="settings-group-title">💾 数据备份与恢复</div>

        <div className={`settings-row ${highlightRow === 'export' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>软件资产清单双格式导出</span>
              {activeNotice?.key === 'export' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">Markdown 报告或 JSON 备份，便于换机</span>
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

        <DataBackupRow />

        <div className={`settings-row ${highlightRow === 'reset' ? 'row-highlight' : ''}`}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>恢复出厂默认设置</span>
              {activeNotice?.key === 'reset' && (
                <span className="setting-applied-badge">{activeNotice.text}</span>
              )}
            </div>
            <span className="settings-row-desc">恢复全部设置为初始值</span>
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
