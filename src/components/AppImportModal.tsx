import React, { useEffect, useState } from 'react';
import {
  ScanLine,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Folder,
  Info,
  X,
} from 'lucide-react';
import { AppMatchResult, ImportAppRequest } from '../types';
import { tauriApi } from '../services/api';
import { EmptyState } from './EmptyState';
import { AppIcon } from './AppIcon';
import { useTranslation } from 'react-i18next';

interface AppImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess: (count: number) => void;
}

export const AppImportModal: React.FC<AppImportModalProps> = ({
  isOpen,
  onClose,
  onImportSuccess,
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [matches, setMatches] = useState<AppMatchResult[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    tauriApi
      .scanAndMatchLocalApps()
      .then((results) => {
        if (!isMounted) return;
        setMatches(results);
        // 默认选中置信度大于等于 0.60 的匹配项
        const initialSelected = new Set(
          results
            .filter((r) => r.confidence >= 0.6)
            .map((r) => r.catalog_id)
        );
        setSelectedIds(initialSelected);
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(String(err));
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleToggleSelect = (catalogId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(catalogId)) {
        next.delete(catalogId);
      } else {
        next.add(catalogId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === matches.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(matches.map((m) => m.catalog_id)));
    }
  };

  const handleImport = async () => {
    const toImport: ImportAppRequest[] = matches
      .filter((m) => selectedIds.has(m.catalog_id))
      .map((m) => ({
        app_id: m.catalog_id,
        app_name: m.name,
        version: m.local_version || m.catalog_version,
        install_path: m.resolved_executable_path || m.scanned.install_location || m.scanned.display_icon || undefined,
        uninstall_command: m.scanned.uninstall_string || undefined,
        installed_at: m.scanned.installed_at || undefined,
      }));

    if (toImport.length === 0) return;

    try {
      setIsImporting(true);
      const importedCount = await tauriApi.importMatchedApps(toImport);
      onImportSuccess(importedCount);
      onClose();
    } catch (err) {
      setError(t('import_modal.import_failed', { error: String(err) }));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isImporting) onClose();
      }}
      style={{ zIndex: 1000 }}
    >
      <div
        className="detail-modal"
        style={{
          width: '100%',
          maxWidth: '740px',
          maxHeight: 'min(86vh, calc(100% - 32px))',
          height: matches.length > 2 ? 'min(82vh, 700px)' : 'auto',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 弹窗头部 */}
        <div
          className="modal-header"
          style={{
            padding: '18px 24px 14px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            background: 'var(--bg-acrylic-thin)',
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ScanLine size={18} strokeWidth={1.5} style={{ color: 'var(--brand-primary)' }} />
              <h3 style={{ margin: 0, fontSize: 'var(--font-xl)', fontWeight: 590, color: 'var(--text-primary)', letterSpacing: '-0.018em' }}>
                {t('import_modal.title')}
              </h3>
            </div>
            <p
              style={{
                margin: '4px 0 0 0',
                fontSize: 'var(--font-base)',
                color: 'var(--text-secondary)',
              }}
            >
              {t('import_modal.description')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isImporting}
            className="modal-header-btn modal-close-btn"
            aria-label={t('import_modal.close')}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* 批量操作工具栏（固定在头部下方） */}
        {!isLoading && !error && matches.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 24px',
              background: 'var(--bg-acrylic)',
              borderBottom: '1px solid var(--border-color)',
              fontSize: 'var(--font-base)',
              flexShrink: 0,
              color: 'var(--text-primary)',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none', color: 'var(--text-primary)', fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={selectedIds.size === matches.length && matches.length > 0}
                onChange={handleSelectAll}
                style={{ cursor: 'pointer', accentColor: 'var(--brand-primary)', width: '16px', height: '16px' }}
              />
              <span>{t('import_modal.select_all')}</span>
            </label>
            <span style={{ color: 'var(--text-secondary)' }}>
              {t('import_modal.summary', { total: matches.length, selected: selectedIds.size })}
            </span>
          </div>
        )}

        {/* 内容区域（可滚动列表） */}
        <div
          className="modal-scroll-area"
          style={{
            padding: matches.length > 0 ? '16px 24px' : '20px 24px',
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          {isLoading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '60px 20px',
                gap: '16px',
              }}
            >
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '50%',
                  border: '3px solid var(--border-color)',
                  borderTopColor: 'var(--brand-primary)',
                  animation: 'spin 1s linear infinite',
                }}
              />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 590, fontSize: 'var(--font-md)', color: 'var(--text-primary)', letterSpacing: '-0.015em' }}>
                  {t('import_modal.scanning')}
                </div>
                <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                  {t('import_modal.comparing')}
                </div>
              </div>
            </div>
          ) : error ? (
            <div
              style={{
                padding: '16px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                color: '#ef4444',
                fontSize: 'var(--font-base)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          ) : matches.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={40} strokeWidth={1.5} style={{ color: 'var(--status-success)' }} />}
              title={t('import_modal.empty_title')}
              description={t('import_modal.empty_desc')}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {matches.map((item) => {
                const isSelected = selectedIds.has(item.catalog_id);
                const isHigh = item.confidence_tier === 'high';
                return (
                  <div
                    key={item.catalog_id}
                    className={`fluent-list-row ${isSelected ? 'active' : ''}`.trim()}
                    onClick={() => handleToggleSelect(item.catalog_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '14px',
                      padding: '14px 16px',
                      background: isSelected ? 'var(--brand-subtle)' : undefined,
                      border: `1px solid ${isSelected ? 'var(--brand-primary)' : 'var(--border-color)'}`,
                      cursor: 'pointer',
                      boxShadow: isSelected ? '0 0 0 1px var(--brand-primary), var(--shadow-rest)' : undefined,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // 由行点击事件统一处理
                      style={{ cursor: 'pointer', accentColor: 'var(--brand-primary)', width: '16px', height: '16px' }}
                    />

                    {/* 图标 */}
                    <AppIcon
                      icon={item.icon}
                      name={item.name}
                      appId={item.catalog_id}
                      iconBg={item.icon_bg || 'var(--brand-subtle)'}
                      size={42}
                      style={{
                        borderRadius: 'var(--radius-sm)',
                        flexShrink: 0,
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
                      }}
                    />

                    {/* 应用信息 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 590, fontSize: 'var(--font-md)', color: 'var(--text-primary)', letterSpacing: '-0.015em' }}>
                          {item.name}
                        </span>
                        <span
                          style={{
                            fontSize: 'var(--font-xs)',
                            padding: '2px 6px',
                            borderRadius: 'var(--radius-xs)',
                            background: isHigh ? 'var(--status-success-bg)' : 'var(--brand-subtle)',
                            color: isHigh ? 'var(--status-success)' : 'var(--brand-primary)',
                            border: `1px solid ${isHigh ? 'rgba(76, 183, 130, 0.3)' : 'var(--border-nav-active)'}`,
                            fontWeight: 510,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '3px',
                          }}
                        >
                          {isHigh ? <ShieldCheck size={11} /> : <Sparkles size={11} />}
                          <span>{t('import_modal.match_rate', { rate: Math.round(item.confidence * 100) })}</span>
                        </span>
                      </div>

                      <div
                        style={{
                          fontSize: 'var(--font-sm)',
                          color: 'var(--text-secondary)',
                          marginTop: '4px',
                          display: 'flex',
                          gap: '12px',
                        }}
                      >
                        <span>{t('import_modal.local_version', { version: item.local_version })}</span>
                        <span>·</span>
                        <span>{t('import_modal.catalog_repo', { repo: item.catalog_id })}</span>
                      </div>

                      {(item.resolved_executable_path || item.scanned.install_location) && (
                        <div
                          className="text-mono"
                          style={{
                            fontSize: 'var(--font-xs)',
                            color: 'var(--text-tertiary)',
                            marginTop: '3px',
                          }}
                          title={item.resolved_executable_path || item.scanned.install_location}
                        >
                          {item.resolved_executable_path ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Terminal size={11} />
                              <span>{t('import_modal.executable', { path: item.resolved_executable_path })}</span>
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Folder size={11} />
                              <span>{t('import_modal.location', { path: item.scanned.install_location })}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div
          className="modal-footer"
          style={{
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontSize: 'var(--font-sm)',
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              marginRight: '16px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <Info size={13} style={{ color: 'var(--brand-primary)', flexShrink: 0 }} />
            <span>{t('import_modal.hint')}</span>
          </span>
          <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              onClick={onClose}
              disabled={isImporting}
            >
              {t('import_modal.cancel')}
            </button>
            <button
              type="button"
              className="btn-fluent btn-primary"
              onClick={handleImport}
              disabled={selectedIds.size === 0 || isImporting || isLoading}
            >
              {isImporting ? (
                <>
                  <span className="spinner-icon" style={{ width: '12px', height: '12px', borderWidth: '1.5px' }} />
                  <span>{t('import_modal.importing')}</span>
                </>
              ) : (
                <span>{t('import_modal.import_btn', { count: selectedIds.size })}</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
