import React, { useState } from 'react';
import { MirrorNodeStatus } from '../types';

interface SettingsViewProps {
  mirrors: MirrorNodeStatus[];
  onSelectMirror: (id: string) => void;
  onPingMirrors: () => void;
  theme: 'light' | 'dark';
  onSetTheme: (theme: 'light' | 'dark') => void;
  onClearCache: () => void;
  onSaveToken: (token: string) => Promise<void>;
  onExportApps: () => void;
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
}) => {
  const [tokenInput, setTokenInput] = useState('');
  const [isTestingPing, setIsTestingPing] = useState(false);

  const handlePing = async () => {
    setIsTestingPing(true);
    try {
      await onPingMirrors();
    } finally {
      setIsTestingPing(false);
    }
  };

  return (
    <div className="settings-view">
      <div className="section-header">
        <h3 className="section-title">⚙️ 系统设置与个性化中枢</h3>
      </div>

      {/* Group 1: Appearance */}
      <div className="settings-group">
        <div className="settings-group-title">🎨 外观与主题样式</div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>色彩主题模式</span>
            <span className="settings-row-desc">选择 Fluent Design 2.0 界面外观</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={`btn-fluent ${theme === 'light' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '6px 14px', fontSize: '12px' }}
              onClick={() => onSetTheme('light')}
            >
              ☀️ 明亮模式 (D-轻1)
            </button>
            <button
              className={`btn-fluent ${theme === 'dark' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '6px 14px', fontSize: '12px' }}
              onClick={() => onSetTheme('dark')}
            >
              🌙 暗黑模式 (D-轻4)
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>亚克力毛玻璃滤镜</span>
            <span className="settings-row-desc">深度利用 Windows 11 Acrylic 高斯模糊与折射高光</span>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--brand-primary)', fontWeight: 600 }}>
            已启用 (原生 GPU 渲染)
          </span>
        </div>
      </div>

      {/* Group 2: Network & Mirrors */}
      <div className="settings-group">
        <div className="settings-group-title">🌐 中国大陆网络加速与镜像分流</div>

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
      </div>

      {/* Group 3: Installation & Storage Paths */}
      <div className="settings-group">
        <div className="settings-group-title">📂 安装与存储路径管理</div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>便携绿色版软件集中目录</span>
            <span className="settings-row-desc">
              解压式开源软件的根存放路径（支持设置于移动硬盘或非系统盘）
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              readOnly
              value="%LOCALAPPDATA%\\Programs\\z-store-apps"
              className="settings-select"
              style={{ width: '280px', color: 'var(--text-tertiary)' }}
            />
            <button
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px' }}
              onClick={() => alert('便携版将优先安全写入该专属目录并创建桌面快捷方式。')}
            >
              浏览位置
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>安装包临时下载缓存</span>
            <span className="settings-row-desc">
              流式下载与 SHA-256 校验时所使用的临时暂存目录
            </span>
          </div>
          <span style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
            %TEMP%\\zstore_downloads
          </span>
        </div>
      </div>

      {/* Group 4: GitHub API Token */}
      <div className="settings-group">
        <div className="settings-group-title">🔑 GitHub API 配额扩展</div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>Personal Access Token (可选)</span>
            <span className="settings-row-desc">
              未配置时每小时 60 次，配置个人只读 Token 可提升至 5000 次/小时
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="password"
              placeholder="ghp_xxxxxxxxxxxx"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="settings-select"
              style={{ width: '220px' }}
            />
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

      {/* Group 4: Data & Export */}
      <div className="settings-group">
        <div className="settings-group-title">💾 数据管理与本地维护</div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>导出已安装开源软件清单</span>
            <span className="settings-row-desc">生成标准 Markdown 软件资产报告，便于换机恢复与团队共享</span>
          </div>
          <button
            className="btn-fluent btn-secondary"
            onClick={onExportApps}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            📋 导出清单
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span style={{ fontWeight: 600 }}>清理本地缓存</span>
            <span className="settings-row-desc">清空下载目录临时安装包及 ETag 索引缓存</span>
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
    </div>
  );
};
