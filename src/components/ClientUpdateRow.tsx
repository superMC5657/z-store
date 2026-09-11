import React, { useState } from 'react';
import { Search, Download, RotateCcw, CheckCircle2, Sparkles, AlertTriangle } from 'lucide-react';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { notifyToast } from '../utils/notify';

type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; currentVersion: string }
  | { kind: 'available'; version: string; currentVersion: string; notes: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

const isTauriEnv = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const ClientUpdateRow: React.FC = () => {
  const [phase, setPhase] = useState<UpdatePhase>({ kind: 'idle' });
  const [updateHandle, setUpdateHandle] = useState<Update | null>(null);
  const [manualRestartHint, setManualRestartHint] = useState(false);

  const fail = (message: string) => {
    setPhase({ kind: 'error', message });
    notifyToast(message, 'error');
  };

  const handleCheck = async () => {
    if (!isTauriEnv) {
      fail('自更新仅在 Tauri 桌面客户端内可用，浏览器预览模式请直接下载安装包');
      return;
    }
    setPhase({ kind: 'checking' });
    setManualRestartHint(false);
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setPhase({ kind: 'latest', currentVersion: '' });
        notifyToast('当前已是最新版本', 'success');
        return;
      }
      setUpdateHandle(update);
      setPhase({
        kind: 'available',
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body || '',
      });
    } catch (e) {
      fail(`检查客户端更新失败: ${String(e)}`);
    }
  };

  const handleDownloadAndInstall = async () => {
    if (!updateHandle) return;
    const version = updateHandle.version;
    setPhase({ kind: 'downloading', version, percent: null });
    try {
      let total: number | null = null;
      let downloaded = 0;
      await updateHandle.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          downloaded = 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
        }
        const percent = total ? Math.min(99, Math.round((downloaded / total) * 100)) : null;
        setPhase({ kind: 'downloading', version, percent });
      });
      setPhase({ kind: 'ready', version });
      notifyToast(`新版本 ${version} 已安装就绪，重启后生效`, 'success');
    } catch (e) {
      fail(`下载安装更新失败: ${String(e)}`);
    } finally {
      try {
        await updateHandle.close();
      } catch {
        // 忽略资源释放异常
      }
      setUpdateHandle(null);
    }
  };

  const handleRestart = async () => {
    setManualRestartHint(false);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:process|restart');
    } catch {
      // 未注册 plugin-process（本仓库未引入该依赖）：提示用户手动重启
      setManualRestartHint(true);
      notifyToast('更新已就绪，请手动重启客户端以完成更新', 'warning');
    }
  };

  const renderAction = () => {
    switch (phase.kind) {
      case 'checking':
        return (
          <button className="btn-fluent btn-secondary" disabled style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RotateCcw size={13} className="icon-spin" />
            <span>正在检查...</span>
          </button>
        );
      case 'available':
        return (
          <button className="btn-fluent btn-primary" onClick={handleDownloadAndInstall} style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Download size={13} />
            <span>下载并安装 {phase.version}</span>
          </button>
        );
      case 'downloading':
        return (
          <button className="btn-fluent btn-secondary" disabled style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RotateCcw size={13} className="icon-spin" />
            <span>{phase.percent !== null ? `下载中 ${phase.percent}%` : '下载中...'}</span>
          </button>
        );
      case 'ready':
        return (
          <button className="btn-fluent btn-primary" onClick={handleRestart} style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RotateCcw size={13} />
            <span>立即重启生效</span>
          </button>
        );
      default:
        return (
          <button className="btn-fluent btn-primary" onClick={handleCheck} style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Search size={13} />
            <span>检查更新</span>
          </button>
        );
    }
  };

  const renderStatus = () => {
    switch (phase.kind) {
      case 'idle':
        return <span className="settings-row-desc">检查新版本</span>;
      case 'checking':
        return <span className="settings-row-desc">正在检查...</span>;
      case 'latest':
        return (
          <span style={{ fontSize: '12px', color: 'var(--status-success)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <CheckCircle2 size={13} />
            <span>当前客户端已是最新版本</span>
          </span>
        );
      case 'available':
        return (
          <span style={{ fontSize: '12px', color: 'var(--brand-primary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <Sparkles size={13} />
            <span>
              发现新版本 {phase.version}{phase.currentVersion ? `（当前 ${phase.currentVersion}）` : ''}
              {phase.notes ? ` — ${phase.notes.slice(0, 120)}` : ''}
            </span>
          </span>
        );
      case 'downloading':
        return (
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <RotateCcw size={13} className="icon-spin" />
            <span>正在下载安装包{phase.percent !== null ? `（${phase.percent}%）` : ''}</span>
          </span>
        );
      case 'ready':
        return (
          <span style={{ fontSize: '12px', color: 'var(--status-success)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <CheckCircle2 size={13} />
            <span>
              新版本 {phase.version} 已安装就绪
              {manualRestartHint ? '，请手动重启客户端以完成更新' : '，点击右侧按钮重启生效'}
            </span>
          </span>
        );
      case 'error':
        return (
          <span style={{ fontSize: '12px', color: 'var(--status-error)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={13} />
            <span>{phase.message}</span>
          </span>
        );
    }
  };

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span style={{ fontWeight: 600 }}>客户端自更新</span>
        {renderStatus()}
      </div>
      {renderAction()}
    </div>
  );
};
