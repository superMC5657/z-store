import React, { useState, useEffect } from 'react';
import { AppSettings, HostRateLimitStatus, HostTokenEntry, MirrorNodeStatus } from '../types';
import { api, DEFAULT_SETTINGS } from '../services/api';

interface SettingsViewProps {
  mirrors: MirrorNodeStatus[];
  onSelectMirror: (id: string) => void;
  onPingMirrors: () => void;
  theme: 'light' | 'dark' | 'system';
  onSetTheme: (theme: 'light' | 'dark' | 'system') => void;
  onClearCache: () => void;
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
  onClearCache,
  onSaveToken,
  onExportApps,
  onExportAppsJson,
  settings,
  onUpdateSetting,
  onResetSettings,
  installedCount,
  updateRulesCount,
  onOpenRules,
}) => {
  const [isTestingPing, setIsTestingPing] = useState(false);
  const [portableDir, setPortableDir] = useState(settings.portable_dir);
  const [catalogSourceUrl, setCatalogSourceUrl] = useState(
    settings.catalog_source_url || 'https://raw.gitmirror.com/supermc/z-store/main/src-tauri/src/catalog.json'
  );
  const [catalogUrlSaved, setCatalogUrlSaved] = useState(false);
  const [showAdvancedSource, setShowAdvancedSource] = useState(false);
  const [copiedPortable, setCopiedPortable] = useState(false);
  const [isBrowsingFolder, setIsBrowsingFolder] = useState(false);
  const [isResetConfirming, setIsResetConfirming] = useState(false);

  // Feature A: Multi-Forge Ecosystem State
  const [hostTokens, setHostTokens] = useState<HostTokenEntry[]>([]);
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});
  const [hostStatus, setHostStatus] = useState<Record<string, HostRateLimitStatus>>({});
  const [isTestingHost, setIsTestingHost] = useState<Record<string, boolean>>({});
  const [showAddHostForm, setShowAddHostForm] = useState(false);
  const [newHostDomain, setNewHostDomain] = useState('');
  const [newHostToken, setNewHostToken] = useState('');
  const [hostFeedback, setHostFeedback] = useState<string | null>(null);
  const [isSyncingCatalog, setIsSyncingCatalog] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  const handleSyncCatalog = async () => {
    setIsSyncingCatalog(true);
    setSyncFeedback(null);
    try {
      const res = await api.syncCatalog(true);
      setSyncFeedback(res.message);
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
    setPortableDir(settings.portable_dir);
    if (settings.catalog_source_url) {
      setCatalogSourceUrl(settings.catalog_source_url);
    }
  }, [settings.portable_dir, settings.catalog_source_url]);

  const handleSaveHostToken = async (host: string) => {
    const val = tokenInputs[host] || '';
    try {
      await api.setHostToken(host, val);
      if (host.toLowerCase() === 'github.com') {
        await onSaveToken(val);
      }
      setHostFeedback(`✅ 已保存 ${host} 的访问令牌`);
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

  const handleAddCustomHost = async () => {
    const domain = newHostDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) return;
    try {
      await api.setHostToken(domain, newHostToken.trim());
      setNewHostDomain('');
      setNewHostToken('');
      setShowAddHostForm(false);
      setHostFeedback(`🎉 成功添加自建 Git 实例: ${domain}`);
      setTimeout(() => setHostFeedback(null), 3000);
      loadHostTokens();
    } catch (e) {
      setHostFeedback(`❌ 添加失败: ${String(e)}`);
    }
  };

  const handleRemoveHost = async (host: string) => {
    try {
      await api.removeHostToken(host);
      setHostFeedback(`🗑️ 已移除 ${host}`);
      setTimeout(() => setHostFeedback(null), 3000);
      loadHostTokens();
    } catch (e) {
      setHostFeedback(`❌ 移除失败: ${String(e)}`);
    }
  };

  const handlePing = async () => {
    setIsTestingPing(true);
    try {
      await onPingMirrors();
    } finally {
      setIsTestingPing(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPortable(true);
    setTimeout(() => setCopiedPortable(false), 2000);
  };

  const handleBrowseFolder = async () => {
    setIsBrowsingFolder(true);
    try {
      const selected = await api.selectFolder(portableDir);
      if (selected) {
        setPortableDir(selected);
        onUpdateSetting('portable_dir', selected);
      }
    } catch (err) {
      console.error('Failed to select folder:', err);
    } finally {
      setIsBrowsingFolder(false);
    }
  };

  const handleResetPortableDir = () => {
    const defaultDir = DEFAULT_SETTINGS.portable_dir;
    setPortableDir(defaultDir);
    onUpdateSetting('portable_dir', defaultDir);
  };

  return (
    <div className="settings-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">⚙️ 系统设置与个性化控制中枢</h3>
      </div>

      {/* Group 1: Display, Resolution & Accessibility */}
      <div className="settings-group">
        <div className="settings-group-title">🖥️ 视窗、显示与无障碍</div>

        {/* 1.1 Theme Mode */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>色彩主题模式</span>
            <span className="settings-row-desc">选择 Fluent Design 2.0 视觉明暗基调，支持跟随系统明暗设置</span>
          </div>
          <div className="segmented-group">
            <button
              className={`segmented-item ${settings.theme === 'light' ? 'active' : ''}`}
              onClick={() => onSetTheme('light')}
            >
              ☀️ 明亮模式
            </button>
            <button
              className={`segmented-item ${settings.theme === 'dark' ? 'active' : ''}`}
              onClick={() => onSetTheme('dark')}
            >
              🌙 暗黑模式
            </button>
            <button
              className={`segmented-item ${settings.theme === 'system' ? 'active' : ''}`}
              onClick={() => onSetTheme('system')}
            >
              💻 跟随系统
            </button>
          </div>
        </div>

        {/* 1.2 UI Scale */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>界面整体缩放比例 (UI Zoom)</span>
            <span className="settings-row-desc">自适应高 DPI 屏幕与显示器缩放比例</span>
          </div>
          <div className="segmented-group">
            {(['90', '100', '110', '125'] as const).map((scale) => (
              <button
                key={scale}
                className={`segmented-item ${settings.ui_scale === scale ? 'active' : ''}`}
                onClick={() => onUpdateSetting('ui_scale', scale)}
              >
                {scale}% {scale === '100' ? '(默认)' : ''}
              </button>
            ))}
          </div>
        </div>

        {/* 1.3 Font Size */}
        {/* 1.3 Font Size (User specified: 12, 14, 16, 18, 20 with step of 2) */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>全局排版字号大小 (Font Size)</span>
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
                onClick={() => onUpdateSetting('font_size', f.id as any)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* 1.4 Always on Top */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>窗口最前端置顶 (Always on Top)</span>
            <span className="settings-row-desc">将 Z-Store 窗口保持在屏幕最上层，便于边查教程边安装软件</span>
          </div>
          <label className="fluent-toggle-wrapper">
            <input
              type="checkbox"
              className="fluent-toggle-input"
              checked={settings.always_on_top}
              onChange={(e) => onUpdateSetting('always_on_top', e.target.checked)}
            />
            <div className="fluent-toggle-track">
              <div className="fluent-toggle-thumb" />
            </div>
          </label>
        </div>
      </div>

      {/* Group 2: Storage & Directory Lifecycle */}
      <div className="settings-group">
        <div className="settings-group-title">📂 目录管理与存储生命周期</div>

        {/* 2.1 Portable App Directory */}
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', gap: '12px' }}>
          <div className="settings-row-info" style={{ flex: 'none' }}>
            <span style={{ fontWeight: 600 }}>安装集中目录</span>
            <span className="settings-row-desc">
              解压式绿色软件及免安装开源工具的集中安装与存放路径。可直接在此编辑自定义路径，也可点击浏览电脑上的文件夹指定。
            </span>
          </div>

          <div className="settings-input-group" style={{ maxWidth: '100%', width: '100%' }}>
            <input
              type="text"
              className="settings-input"
              style={{ flex: 1 }}
              placeholder="请输入或选择电脑上的文件夹路径（支持环境变量如 %LOCALAPPDATA%）..."
              value={portableDir}
              onChange={(e) => setPortableDir(e.target.value)}
              onBlur={() => onUpdateSetting('portable_dir', portableDir)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onUpdateSetting('portable_dir', portableDir);
                }
              }}
            />
            <button
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 14px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={handleBrowseFolder}
              disabled={isBrowsingFolder}
              title="浏览电脑文件夹并指定为安装集中目录"
            >
              <span>📁</span>
              <span>{isBrowsingFolder ? '选择中...' : '浏览文件夹'}</span>
            </button>
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px' }}
              onClick={handleResetPortableDir}
              disabled={portableDir === DEFAULT_SETTINGS.portable_dir}
              title={`恢复为系统默认目录 (${DEFAULT_SETTINGS.portable_dir})`}
            >
              <span>↩️</span>
              <span>恢复默认</span>
            </button>
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px', flexShrink: 0 }}
              onClick={() => handleCopy(portableDir)}
              title="复制当前路径到剪贴板"
            >
              {copiedPortable ? '✓ 已复制' : '复制路径'}
            </button>
          </div>
        </div>

        {/* 2.2 Auto-clean installer cache */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>安装成功后自动销毁临时安装包</span>
            <span className="settings-row-desc">
              当 MSI/EXE/ZIP 安装或解压完成后，自动清理临时下载缓存以节省系统磁盘空间
            </span>
          </div>
          <label className="fluent-toggle-wrapper">
            <input
              type="checkbox"
              className="fluent-toggle-input"
              checked={settings.auto_clean_cache}
              onChange={(e) => onUpdateSetting('auto_clean_cache', e.target.checked)}
            />
            <div className="fluent-toggle-track">
              <div className="fluent-toggle-thumb" />
            </div>
          </label>
        </div>

        {/* 2.3 Catalog Manifest Sync (With advanced source fold) */}
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div className="settings-row-info">
              <span style={{ fontWeight: 600 }}>开源收录清单动态同步</span>
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
                  const defUrl = 'https://raw.gitmirror.com/supermc/z-store/main/src-tauri/src/catalog.json';
                  setCatalogSourceUrl(defUrl);
                  onUpdateSetting('catalog_source_url', defUrl);
                  setCatalogUrlSaved(true);
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

        {/* 2.4 Clear Cache */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>深度清理临时缓存与残留</span>
            <span className="settings-row-desc">清空下载暂存目录残留安装包、应用详情元数据及 GitHub Release ETag 索引</span>
          </div>
          <button
            className="btn-fluent btn-secondary"
            onClick={onClearCache}
            style={{ fontSize: '12px', padding: '6px 14px', color: '#ef4444' }}
          >
            🧹 一键深度清理
          </button>
        </div>
      </div>

      {/* Group 3: Network & Multi-Forge Ecosystem */}
      <div className="settings-group">
        <div className="settings-group-title">🌐 中国大陆网络加速与代码托管平台</div>

        {/* 3.1 Mirror Speed Ping */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>并发测速与线路优选</span>
            <span className="settings-row-desc">动态探测各镜像节点网络响应时间，智能选择最优加速线路</span>
          </div>
          <button
            className="btn-fluent btn-secondary"
            onClick={handlePing}
            disabled={isTestingPing}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            {isTestingPing ? '⚡ 正在测速...' : '⚡ 开始并发测速'}
          </button>
        </div>

        {mirrors.map((m) => (
          <div key={m.id} className="settings-row">
            <div className="settings-row-info">
              <span style={{ fontWeight: 600 }}>{m.name}</span>
              <span className="settings-row-desc">{m.base_url}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: m.latency_ms < 100 ? '#10b981' : m.latency_ms < 300 ? '#f59e0b' : '#ef4444',
                }}
              >
                {m.latency_ms} ms
              </span>
              <button
                className={`btn-fluent ${m.is_active ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: '12px', padding: '5px 14px' }}
                onClick={() => onSelectMirror(m.id)}
              >
                {m.is_active ? '当前活跃线路' : '选用此线路'}
              </button>
            </div>
          </div>
        ))}

        {/* 3.3 Multi-Forge Ecosystem & PATs */}
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="settings-row-info">
              <span style={{ fontWeight: 600 }}>🌐 多代码托管平台与 API 令牌管理 (Multi-Forge)</span>
              <span className="settings-row-desc">
                原生直连 GitHub、Codeberg 及自建 Gitea/Forgejo 实例，独立管理个人访问令牌（PAT）以解除 API 速率限制
              </span>
            </div>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '5px 12px', borderRadius: '6px' }}
              onClick={() => setShowAddHostForm(!showAddHostForm)}
            >
              {showAddHostForm ? '✕ 取消' : '＋ 添加自建 Git 实例'}
            </button>
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

          {/* Add custom host form */}
          {showAddHostForm && (
            <div
              style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'center',
                padding: '12px',
                borderRadius: '8px',
                background: 'var(--card-bg-subtle, rgba(255,255,255,0.04))',
                border: '1px dashed var(--border-color)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 200px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>主机域名 (例如 git.disroot.org / gitea.lan)</span>
                <input
                  type="text"
                  placeholder="git.example.com"
                  className="settings-input"
                  value={newHostDomain}
                  onChange={(e) => setNewHostDomain(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 240px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>访问令牌 Access Token (可选，私有库必填)</span>
                <input
                  type="password"
                  placeholder="token / pat_xxxxxxxx"
                  className="settings-input"
                  value={newHostToken}
                  onChange={(e) => setNewHostToken(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', alignSelf: 'flex-end', paddingTop: '18px' }}>
                <button
                  type="button"
                  className="btn-fluent btn-primary"
                  style={{ fontSize: '12px', padding: '6px 14px' }}
                  onClick={handleAddCustomHost}
                  disabled={!newHostDomain.trim()}
                >
                  确认添加
                </button>
              </div>
            </div>
          )}

          {/* Host list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {['github.com', 'codeberg.org', ...hostTokens.map((t) => t.host).filter((h) => h !== 'github.com' && h !== 'codeberg.org')].map((host) => {
              const isBuiltin = host === 'github.com' || host === 'codeberg.org';
              const icon = host === 'github.com' ? '🐙' : host === 'codeberg.org' ? '🏔️' : '🍵';
              const label = host === 'github.com' ? 'GitHub (默认源)' : host === 'codeberg.org' ? 'Codeberg (自由开源)' : `自建实例 (${host})`;
              const tokenVal = tokenInputs[host] !== undefined ? tokenInputs[host] : (hostTokens.find((t) => t.host === host)?.token || '');
              const isShowing = !!showTokens[host];
              const status = hostStatus[host];
              const isTesting = !!isTestingHost[host];

              return (
                <div
                  key={host}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    background: 'var(--card-bg-subtle, rgba(255,255,255,0.02))',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '16px' }}>{icon}</span>
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>{label}</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{host}</span>
                    </div>
                    {status && (
                      <span
                        style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          background: status.is_connected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: status.is_connected ? '#10b981' : '#ef4444',
                          border: `1px solid ${status.is_connected ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        {status.is_connected ? '🟢' : '🔴'} {status.message || (status.is_connected ? `配额剩余: ${status.rate_limit_remaining ?? '充裕'}` : '连接失败')}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ position: 'relative', flex: '1 1 240px' }}>
                      <input
                        type={isShowing ? 'text' : 'password'}
                        placeholder={host === 'github.com' ? 'ghp_xxxxxxxxxxxx (只读权限)' : 'Token / Personal Access Token'}
                        value={tokenVal}
                        onChange={(e) => setTokenInputs({ ...tokenInputs, [host]: e.target.value })}
                        className="settings-input"
                        style={{ width: '100%', paddingRight: '32px' }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowTokens({ ...showTokens, [host]: !isShowing })}
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
                        title={isShowing ? '隐藏凭据' : '显示凭据'}
                      >
                        {isShowing ? '🙈' : '👁️'}
                      </button>
                    </div>

                    <button
                      type="button"
                      className="btn-fluent btn-primary"
                      style={{ fontSize: '12px', padding: '5px 12px' }}
                      onClick={() => handleSaveHostToken(host)}
                    >
                      保存
                    </button>

                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '5px 12px' }}
                      disabled={isTesting}
                      onClick={() => handleTestHost(host)}
                    >
                      {isTesting ? '正在探测...' : '测试连通性'}
                    </button>

                    {!isBuiltin && (
                      <button
                        type="button"
                        className="btn-fluent btn-secondary"
                        style={{ fontSize: '12px', padding: '5px 10px', color: '#ef4444' }}
                        onClick={() => handleRemoveHost(host)}
                        title="删除该自建实例"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Group 4: Startup & System Behaviors */}
      <div className="settings-group">
        <div className="settings-group-title">🚀 启动与系统行为</div>

        {/* 4.1 Close Window Behavior */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>关闭主窗口时行为</span>
            <span className="settings-row-desc">点击右上角关闭按钮时的应用程序处置方式</span>
          </div>
          <div className="segmented-group">
            <button
              className={`segmented-item ${settings.close_to_tray ? 'active' : ''}`}
              onClick={() => onUpdateSetting('close_to_tray', true)}
            >
              最小化至托盘
            </button>
            <button
              className={`segmented-item ${!settings.close_to_tray ? 'active' : ''}`}
              onClick={() => onUpdateSetting('close_to_tray', false)}
            >
              直接退出程序
            </button>
          </div>
        </div>

        {/* 4.2 Auto Launch on Startup */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>开机自动静默启动</span>
            <span className="settings-row-desc">系统登录后自动在后台保持就绪，静默纳管更新</span>
          </div>
          <label className="fluent-toggle-wrapper">
            <input
              type="checkbox"
              className="fluent-toggle-input"
              checked={settings.launch_on_startup}
              onChange={(e) => onUpdateSetting('launch_on_startup', e.target.checked)}
            />
            <div className="fluent-toggle-track">
              <div className="fluent-toggle-thumb" />
            </div>
          </label>
        </div>

        {/* 4.3 Update Frequency */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>自动检查更新频率</span>
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
                onClick={() => onUpdateSetting('update_frequency', u.id as any)}
              >
                {u.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Group 5: Update Policies & Rules Center */}
      <div className="settings-group">
        <div className="settings-group-title">🛡️ 版本策略与软件屏蔽规则</div>
        <div className="settings-row" style={{ alignItems: 'center' }}>
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>更新忽略、版本锁定与全局隐藏规则看板</span>
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
            <span>📋 打开规则管理看板</span>
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

      {/* Group 6: Data, Diagnostics & Factory Reset */}
      <div className="settings-group">
        <div className="settings-group-title">📊 软件资产、系统诊断与恢复</div>

        {/* 6.1 Export Assets */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>软件资产清单双格式导出</span>
            <span className="settings-row-desc">生成标准 Markdown 资产报告或 JSON 结构化备份，便于换机一键装机</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-fluent btn-secondary"
              onClick={onExportApps}
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              📋 导出 Markdown 清单
            </button>
            <button
              className="btn-fluent btn-primary"
              onClick={onExportAppsJson}
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              💾 导出 JSON 备份文件
            </button>
          </div>
        </div>

        {/* 5.2 System Diagnostics Card */}
        <div className="diagnostics-card">
          <div className="diagnostic-item">
            <span className="diagnostic-label">操作系统平台</span>
            <span className="diagnostic-value">Windows 11 (x86_64)</span>
          </div>
          <div className="diagnostic-item">
            <span className="diagnostic-label">桌面运行内核</span>
            <span className="diagnostic-value">Tauri 2.2 + WebView2</span>
          </div>
          <div className="diagnostic-item">
            <span className="diagnostic-label">本地数据存储</span>
            <span className="diagnostic-value">SQLite 3 (WAL Mode)</span>
          </div>
          <div className="diagnostic-item">
            <span className="diagnostic-label">当前纳管应用</span>
            <span className="diagnostic-value">{installedCount} 款开源软件</span>
          </div>
          <div className="diagnostic-item">
            <span className="diagnostic-label">加速分流节点</span>
            <span className="diagnostic-value">{settings.active_mirror || 'ghproxy'}</span>
          </div>
          <div className="diagnostic-item">
            <span className="diagnostic-label">防篡改校验引擎</span>
            <span className="diagnostic-value">SHA-256 (Streaming)</span>
          </div>
        </div>

        {/* 5.3 Reset to Defaults */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>恢复出厂默认设置</span>
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
                onClick={async () => {
                  await onResetSettings();
                  setIsResetConfirming(false);
                }}
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
