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
} from 'lucide-react';
import { AppMatchResult, ImportAppRequest } from '../types';
import { api } from '../services/api';

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

    api
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
      }));

    if (toImport.length === 0) return;

    try {
      setIsImporting(true);
      const importedCount = await api.importMatchedApps(toImport);
      onImportSuccess(importedCount);
      onClose();
    } catch (err) {
      setError(`导入失败: ${String(err)}`);
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
        {/* Header */}
        <div
          className="modal-header"
          style={{
            padding: '18px 24px 14px',
            borderBottom: '1px solid var(--border-acrylic)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            background: 'var(--bg-acrylic-thin)',
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ScanLine size={20} style={{ color: 'var(--brand-primary)' }} />
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>
                扫描并添加本地应用
              </h3>
            </div>
            <p
              style={{
                margin: '4px 0 0 0',
                fontSize: '13px',
                color: 'var(--text-secondary)',
              }}
            >
              扫描本机已安装软件，匹配开源库以获取更新提醒与快捷管理。
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isImporting}
            className="modal-close-btn"
            aria-label="关闭"
            style={{ position: 'relative', top: 'auto', right: 'auto' }}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        </div>

        {/* Batch Actions Toolbar (Pinned below Header) */}
        {!isLoading && !error && matches.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 24px',
              background: 'var(--bg-acrylic)',
              borderBottom: '1px solid var(--border-acrylic)',
              fontSize: '13px',
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
              <span>全选 / 反选</span>
            </label>
            <span style={{ color: 'var(--text-secondary)' }}>
              共发现 <strong style={{ color: 'var(--text-primary)' }}>{matches.length}</strong> 款开源软件 · 已选中 <strong style={{ color: 'var(--brand-primary)' }}>{selectedIds.size}</strong> 款
            </span>
          </div>
        )}

        {/* Body (Scrollable List) */}
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
                  border: '3px solid var(--border-acrylic)',
                  borderTopColor: 'var(--brand-primary)',
                  animation: 'spin 1s linear infinite',
                }}
              />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>正在扫描系统已安装软件...</div>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                  正在比对开源收录清单
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
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          ) : matches.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '60px 20px',
                color: 'var(--text-tertiary)',
              }}
            >
              <CheckCircle2 size={44} strokeWidth={1.5} style={{ color: 'var(--status-success)', margin: '0 auto 12px' }} />
              <h4 style={{ margin: '0 0 8px 0', fontSize: '16px', color: 'var(--text-primary)' }}>
                未发现可添加的本地应用
              </h4>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
                本机开源软件均已在管理列表中，或未发现匹配的程序。
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {matches.map((item) => {
                const isSelected = selectedIds.has(item.catalog_id);
                const isHigh = item.confidence_tier === 'high';
                return (
                  <div
                    key={item.catalog_id}
                    onClick={() => handleToggleSelect(item.catalog_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '14px',
                      padding: '14px 16px',
                      background: isSelected ? 'var(--brand-subtle)' : 'var(--bg-acrylic)',
                      border: `1px solid ${isSelected ? 'var(--brand-primary)' : 'var(--border-acrylic)'}`,
                      borderRadius: 'var(--radius-md)',
                      cursor: 'pointer',
                      transition: 'all 0.18s var(--ease-smooth)',
                      boxShadow: isSelected ? '0 0 0 1px var(--brand-primary), var(--shadow-rest)' : 'var(--shadow-rest)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // handled by row click
                      style={{ cursor: 'pointer', accentColor: 'var(--brand-primary)', width: '16px', height: '16px' }}
                    />

                    {/* Icon */}
                    <div
                      style={{
                        width: '42px',
                        height: '42px',
                        borderRadius: 'var(--radius-sm)',
                        background: item.icon_bg || 'var(--brand-subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        fontSize: '22px',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
                      }}
                    >
                      {item.icon.endsWith('.svg') || item.icon.startsWith('http') ? (
                        '📦'
                      ) : (
                        item.icon
                      )}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                          {item.name}
                        </span>
                        {item.chinese_name && (
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            ({item.chinese_name})
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: '11px',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            background: isHigh ? 'var(--status-success-bg)' : 'var(--brand-subtle)',
                            color: isHigh ? 'var(--status-success)' : 'var(--brand-primary)',
                            border: `1px solid ${isHigh ? 'rgba(16, 185, 129, 0.3)' : 'rgba(0, 120, 212, 0.3)'}`,
                            fontWeight: 600,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '3px',
                          }}
                        >
                          {isHigh ? <ShieldCheck size={11} /> : <Sparkles size={11} />}
                          <span>{Math.round(item.confidence * 100)}% 匹配</span>
                        </span>
                      </div>

                      <div
                        style={{
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginTop: '4px',
                          display: 'flex',
                          gap: '12px',
                        }}
                      >
                        <span>本地检测: <strong style={{ color: 'var(--text-primary)' }}>v{item.local_version}</strong></span>
                        <span>·</span>
                        <span>收录仓库: <code style={{ color: 'var(--brand-primary)', background: 'var(--brand-subtle)', padding: '1px 5px', borderRadius: '4px' }}>{item.catalog_id}</code></span>
                      </div>

                      {(item.resolved_executable_path || item.scanned.install_location) && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--text-tertiary)',
                            fontFamily: 'Consolas, Monaco, monospace',
                            marginTop: '3px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={item.resolved_executable_path || item.scanned.install_location}
                        >
                          {item.resolved_executable_path ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Terminal size={11} />
                              <span>程序: {item.resolved_executable_path}</span>
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Folder size={11} />
                              <span>目录: {item.scanned.install_location}</span>
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

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-acrylic)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-acrylic-thin)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: '12px',
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
            <span>添加后可在「应用更新」接收新版本提醒</span>
          </span>
          <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
            <button
              className="btn-fluent btn-secondary"
              onClick={onClose}
              disabled={isImporting}
              style={{ padding: '6px 16px', fontSize: '13px' }}
            >
              取消
            </button>
            <button
              className="btn-fluent btn-primary"
              onClick={handleImport}
              disabled={selectedIds.size === 0 || isImporting || isLoading}
              style={{ padding: '6px 20px', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {isImporting ? (
                <>
                  <span
                    style={{
                      display: 'inline-block',
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: '#fff',
                      animation: 'spin 1s linear infinite',
                    }}
                  />
                  <span>正在添加...</span>
                </>
              ) : (
                <span>添加已选应用 ({selectedIds.size})</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
