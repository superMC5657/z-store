import React, { useRef, useState } from 'react';
import { Search, Download, RotateCcw, CheckCircle2, Sparkles, AlertTriangle } from 'lucide-react';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { useTranslation } from 'react-i18next';
import { notifyToast } from '../utils/notify';
import { isTauri } from '../services/api';
import { resolveUpdateFeed, ZSTORE_REPO } from '../utils/updateManifest';

type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; currentVersion: string }
  | { kind: 'available'; version: string; currentVersion: string; notes: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string; fallback?: { label: string; url: string } };

// P3-4 契约：客户端自更新面板（check/downloadAndInstall，配置见 tauri.conf.json plugins.updater，状态机见下方本地 UpdatePhase）。
export const ClientUpdateRow: React.FC = () => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase>({ kind: 'idle' });
  const [updateHandle, setUpdateHandle] = useState<Update | null>(null);
  const [manualRestartHint, setManualRestartHint] = useState(false);
  const checkTokenRef = useRef(0);

  const fail = (message: string) => {
    setPhase({ kind: 'error', message });
    notifyToast(message, 'error');
  };

  const handleCheck = async () => {
    if (!isTauri) {
      fail(t('client_update.tauri_only'));
      return;
    }
    const currentToken = ++checkTokenRef.current;
    setPhase({ kind: 'checking' });
    setManualRestartHint(false);
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setPhase({ kind: 'latest', currentVersion: '' });
        notifyToast(t('client_update.is_latest_toast'), 'success');
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
      fail(t('client_update.check_failed', { error: String(e) }));
      try {
        const feed = await resolveUpdateFeed({ repo: ZSTORE_REPO, timeoutMs: 10000 });
        if (checkTokenRef.current !== currentToken) {
          return;
        }
        let fallback: { label: string; url: string } | undefined;
        if (feed.source === 'manifest') {
          const platform = feed.manifest.platforms['windows-x86_64'] ?? Object.values(feed.manifest.platforms)[0];
          if (platform?.url) {
            fallback = {
              label: t('client_update.manual_download', { version: feed.manifest.version }),
              url: platform.url,
            };
          }
        } else if (feed.source === 'releases-api') {
          const entries = Object.values(feed.manifest.platforms);
          const preferred =
            entries.find((p) => {
              const name = (p.name ?? p.url).toLowerCase();
              return name.includes('x64') || name.includes('.exe');
            }) ?? entries[0];
          if (preferred?.url) {
            fallback = {
              label: t('client_update.manual_download', { version: feed.manifest.version }),
              url: preferred.url,
            };
          }
        } else if (feed.source === 'releases-page') {
          fallback = {
            label: t('client_update.open_releases_page'),
            url: feed.url,
          };
        }
        if (fallback) {
          setPhase((prev) => (prev.kind === 'error' ? { ...prev, fallback } : prev));
        }
      } catch {
        // resolveUpdateFeed 设计上不 reject，仍 try/catch 静默兜底
      }
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
      notifyToast(t('client_update.ready_toast', { version }), 'success');
    } catch (e) {
      fail(t('client_update.download_failed', { error: String(e) }));
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
      notifyToast(t('client_update.manual_restart_toast'), 'warning');
    }
  };

  const renderAction = () => {
    switch (phase.kind) {
      case 'checking':
        return (
          <button className="btn-fluent btn-sm btn-secondary" disabled style={{ gap: '6px' }}>
            <RotateCcw size={14} strokeWidth={1.5} className="icon-spin" />
            <span>{t('client_update.checking')}</span>
          </button>
        );
      case 'available':
        return (
          <button className="btn-fluent btn-sm btn-primary" onClick={handleDownloadAndInstall} style={{ gap: '6px' }}>
            <Download size={14} strokeWidth={1.5} />
            <span>{t('client_update.download_and_install', { version: phase.version })}</span>
          </button>
        );
      case 'downloading':
        return (
          <button className="btn-fluent btn-sm btn-secondary" disabled style={{ gap: '6px' }}>
            <RotateCcw size={14} strokeWidth={1.5} className="icon-spin" />
            <span>{phase.percent !== null ? t('client_update.downloading_percent', { percent: phase.percent }) : t('client_update.downloading_btn')}</span>
          </button>
        );
      case 'ready':
        return (
          <button className="btn-fluent btn-sm btn-primary" onClick={handleRestart} style={{ gap: '6px' }}>
            <RotateCcw size={14} strokeWidth={1.5} />
            <span>{t('client_update.restart_btn')}</span>
          </button>
        );
      default:
        return (
          <button className="btn-fluent btn-sm btn-secondary" onClick={handleCheck} style={{ gap: '6px' }}>
            <Search size={14} strokeWidth={1.5} />
            <span>{t('client_update.check_btn')}</span>
          </button>
        );
    }
  };

  const renderStatus = () => {
    switch (phase.kind) {
      case 'idle':
        return null;
      case 'checking':
        return <span className="settings-row-desc">{t('client_update.checking')}</span>;
      case 'latest':
        return (
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--status-success)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <CheckCircle2 size={13} />
            <span>{t('client_update.latest')}</span>
          </span>
        );
      case 'available':
        return (
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--brand-primary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <Sparkles size={13} />
            <span>
              {t('client_update.available', { version: phase.version })}
              {phase.currentVersion ? ` (${t('client_update.current_version', { version: phase.currentVersion })})` : ''}
              {phase.notes ? ` — ${phase.notes.slice(0, 120)}` : ''}
            </span>
          </span>
        );
      case 'downloading':
        return (
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <RotateCcw size={13} className="icon-spin" />
            <span>{t('client_update.downloading_package', { percent: phase.percent !== null ? ` (${phase.percent}%)` : '' })}</span>
          </span>
        );
      case 'ready':
        return (
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--status-success)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <CheckCircle2 size={13} />
            <span>
              {t('client_update.ready', { version: phase.version })}
              {manualRestartHint ? t('client_update.manual_restart_hint') : t('client_update.click_restart_hint')}
            </span>
          </span>
        );
      case 'error':
        return (
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--status-error)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={13} />
            <span>{phase.message}</span>
            {phase.fallback && (
              <a
                href={phase.fallback.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 'var(--font-sm)', color: 'var(--brand-primary)', textDecoration: 'underline' }}
              >
                {phase.fallback.label}
              </a>
            )}
          </span>
        );
    }
  };

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span style={{ fontWeight: 510 }}>{t('client_update.title')}</span>
        {renderStatus()}
      </div>
      {renderAction()}
    </div>
  );
};
