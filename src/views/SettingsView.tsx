import React, { useState } from 'react';
import { AppSettings, MirrorNodeStatus } from '../types';

interface SettingsViewProps {
  mirrors: MirrorNodeStatus[];
  onSelectMirror: (id: string) => void;
  onPingMirrors: () => void;
  theme: 'light' | 'dark';
  onSetTheme: (theme: 'light' | 'dark') => void;
  onClearCache: () => void;
  onSaveToken: (token: string) => Promise<void>;
  onExportApps: () => void;
  onExportAppsJson: () => void;
  settings: AppSettings;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onResetSettings: () => Promise<void>;
  installedCount: number;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  mirrors,
  onSelectMirror,
  onPingMirrors,
  theme,
  onSetTheme,
  onClearCache,
  onSaveToken,
  onExportApps,
  onExportAppsJson,
  settings,
  onUpdateSetting,
  onResetSettings,
  installedCount,
}) => {
  const [tokenInput, setTokenInput] = useState(settings.github_token || '');
  const [showToken, setShowToken] = useState(false);
  const [isTestingPing, setIsTestingPing] = useState(false);
  const [portableDir, setPortableDir] = useState(settings.portable_dir);
  const [downloadDir, setDownloadDir] = useState(settings.download_dir);
  const [copiedField, setCopiedField] = useState<'portable' | 'download' | null>(null);
  const [isResetConfirming, setIsResetConfirming] = useState(false);

  const handlePing = async () => {
    setIsTestingPing(true);
    try {
      await onPingMirrors();
    } finally {
      setIsTestingPing(false);
    }
  };

  const handleCopy = (text: string, field: 'portable' | 'download') => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
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
            <span className="settings-row-desc">选择 Fluent Design 2.0 视觉明暗基调</span>
          </div>
          <div className="segmented-group">
            <button
              className={`segmented-item ${theme === 'light' ? 'active' : ''}`}
              onClick={() => onSetTheme('light')}
            >
              ☀️ 明亮模式
            </button>
            <button
              className={`segmented-item ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => onSetTheme('dark')}
            >
              🌙 暗黑模式
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
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>全局字体字阶大小</span>
            <span className="settings-row-desc">调整排版文字大小，即刻响应全界面字阶变化</span>
          </div>
          <div className="segmented-group">
            {[
              { id: 'small', label: '紧凑 12px' },
              { id: 'standard', label: '标准 13.5px' },
              { id: 'medium', label: '舒适 15px' },
              { id: 'large', label: '特大 16.5px' },
            ].map((f) => (
              <button
                key={f.id}
                className={`segmented-item ${settings.font_size === f.id ? 'active' : ''}`}
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

        {/* 2.1 Portable Apps Root Directory */}
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div className="settings-row-info">
              <span style={{ fontWeight: 600 }}>便携绿色版开源软件集中目录</span>
              <span className="settings-row-desc">
                解压式绿色软件的根存放路径（支持自定义于大容量或外置移动磁盘）
              </span>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', alignSelf: 'center' }}>快捷预设:</span>
              {[
                { label: '系统默认', path: '%LOCALAPPDATA%\\Programs\\z-store-apps' },
                { label: 'D 盘目录', path: 'D:\\ZStoreApps' },
                { label: 'E 盘工具', path: 'E:\\PortableTools' },
              ].map((preset) => (
                <button
                  key={preset.label}
                  className="btn-fluent btn-secondary"
                  style={{ fontSize: '11px', padding: '2px 8px' }}
                  onClick={() => {
                    setPortableDir(preset.path);
                    onUpdateSetting('portable_dir', preset.path);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-input-group" style={{ maxWidth: '100%' }}>
            <input
              type="text"
              className="settings-input"
              value={portableDir}
              onChange={(e) => setPortableDir(e.target.value)}
              onBlur={() => onUpdateSetting('portable_dir', portableDir)}
            />
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px', flexShrink: 0 }}
              onClick={() => handleCopy(portableDir, 'portable')}
            >
              {copiedField === 'portable' ? '✓ 已复制' : '复制路径'}
            </button>
          </div>
        </div>

        {/* 2.2 Download Cache Directory */}
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>流式下载临时缓存目录</span>
            <span className="settings-row-desc">
              安装包分片下载与 SHA-256 完整性强校验时所使用的临时暂存区
            </span>
          </div>
          <div className="settings-input-group" style={{ maxWidth: '100%' }}>
            <input
              type="text"
              className="settings-input"
              value={downloadDir}
              onChange={(e) => setDownloadDir(e.target.value)}
              onBlur={() => onUpdateSetting('download_dir', downloadDir)}
            />
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px', flexShrink: 0 }}
              onClick={() => handleCopy(downloadDir, 'download')}
            >
              {copiedField === 'download' ? '✓ 已复制' : '复制路径'}
            </button>
          </div>
        </div>

        {/* 2.3 Auto-clean installer cache */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>安装成功后自动销毁安装包</span>
            <span className="settings-row-desc">
              当 MSI/EXE/ZIP 安装或解压完成后，自动清理下载缓存以节省系统固态盘空间
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

        {/* 2.4 Clear Cache */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>深度清理临时缓存与 ETag 索引</span>
            <span className="settings-row-desc">清空下载目录残留文件及 GitHub Release 304 缓存</span>
          </div>
          <button
            className="btn-fluent btn-secondary"
            onClick={onClearCache}
            style={{ fontSize: '12px', padding: '6px 14px', color: '#ef4444' }}
          >
            🧹 一键清理
          </button>
        </div>
      </div>

      {/* Group 3: Network & Concurrency */}
      <div className="settings-group">
        <div className="settings-group-title">🌐 中国大陆网络加速与并发限制</div>

        {/* 3.1 Max Concurrent Downloads */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>最大并发下载任务数</span>
            <span className="settings-row-desc">限制同时流式下载的任务上限，避免挤占局域网带宽</span>
          </div>
          <div className="segmented-group">
            {[
              { val: 1, label: '1 (单任务稳健)' },
              { val: 3, label: '3 (标准推荐)' },
              { val: 5, label: '5 (千兆并发)' },
            ].map((c) => (
              <button
                key={c.val}
                className={`segmented-item ${settings.max_concurrent_downloads === c.val ? 'active' : ''}`}
                onClick={() => onUpdateSetting('max_concurrent_downloads', c.val)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* 3.2 Mirror Speed Ping */}
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

        {/* 3.3 GitHub PAT */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>GitHub Personal Access Token (可选)</span>
            <span className="settings-row-desc">
              未配置时公共 IP 限制 60 次/小时，配置个人只读 Token 可提升至 5000 次/小时
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ position: 'relative' }}>
              <input
                type={showToken ? 'text' : 'password'}
                placeholder="ghp_xxxxxxxxxxxx"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="settings-input"
                style={{ width: '220px', paddingRight: '32px' }}
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
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
                title={showToken ? '隐藏凭据' : '显示凭据'}
              >
                {showToken ? '🙈' : '👁️'}
              </button>
            </div>
            <button
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 14px' }}
              onClick={() => onSaveToken(tokenInput)}
            >
              保存凭据
            </button>
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

      {/* Group 5: Data, Diagnostics & Factory Reset */}
      <div className="settings-group">
        <div className="settings-group-title">📊 软件资产、系统诊断与恢复</div>

        {/* 5.1 Export Assets */}
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
