import React, { useEffect, useState } from 'react';
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
      setError(`纳管导入失败: ${String(err)}`);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isImporting) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(16px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        className="modal-content"
        style={{
          width: '100%',
          maxWidth: '720px',
          maxHeight: '86vh',
          background: 'var(--bg-acrylic-default)',
          backdropFilter: 'blur(30px) saturate(180%)',
          border: '1px solid var(--border-acrylic)',
          borderRadius: '12px',
          boxShadow: '0 24px 48px rgba(0,0,0,0.36)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'fadeIn 0.2s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--border-acrylic)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '20px' }}>🔍</span>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
                扫描并纳管系统存量开源软件
              </h3>
            </div>
            <p
              style={{
                margin: '6px 0 0 0',
                fontSize: '13px',
                color: 'var(--text-secondary)',
              }}
            >
              检索本机已安装的应用程序，与 Z-Store 官方收录库匹配并一键接管自动版本更新。
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isImporting}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '18px',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: '6px',
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', flex: 1, overflowY: 'auto' }}>
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
                <div style={{ fontWeight: 600, fontSize: '14px' }}>正在遍历 Windows 注册表与系统已装程序...</div>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                  应用启发式打分引擎比对 Catalog 倒排索引
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
              }}
            >
              ⚠️ {error}
            </div>
          ) : matches.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '60px 20px',
                color: 'var(--text-tertiary)',
              }}
            >
              <div style={{ fontSize: '48px', marginBottom: '12px' }}>✅</div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '16px', color: 'var(--text-primary)' }}>
                未检测到未纳管的已知开源应用
              </h4>
              <p style={{ margin: 0, fontSize: '13px' }}>
                当前系统中的已知开源软件已全部处于 Z-Store 纳管监控中，或尚未检测到与内置收录库匹配的程序。
              </p>
            </div>
          ) : (
            <div>
              {/* Batch Actions Toolbar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'var(--bg-acrylic-thin)',
                  borderRadius: '8px',
                  marginBottom: '16px',
                  fontSize: '13px',
                  border: '1px solid var(--border-acrylic)',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.size === matches.length && matches.length > 0}
                    onChange={handleSelectAll}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>全选 / 反选</span>
                </label>
                <span style={{ color: 'var(--text-secondary)' }}>
                  共发现 <strong>{matches.length}</strong> 款开源软件 · 已选中 <strong>{selectedIds.size}</strong> 款
                </span>
              </div>

              {/* Matches List */}
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
                        padding: '12px 16px',
                        background: isSelected ? 'var(--brand-subtle)' : 'var(--bg-acrylic-thin)',
                        border: `1px solid ${isSelected ? 'var(--brand-primary)' : 'var(--border-acrylic)'}`,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}} // handled by row click
                        style={{ cursor: 'pointer' }}
                      />

                      {/* Icon */}
                      <div
                        style={{
                          width: '40px',
                          height: '40px',
                          borderRadius: '8px',
                          background: item.icon_bg || 'var(--brand-subtle)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          fontSize: '20px',
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontWeight: 600, fontSize: '14px' }}>
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
                              background: isHigh ? 'rgba(16, 185, 129, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                              color: isHigh ? '#10b981' : '#3b82f6',
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '3px',
                            }}
                          >
                            {isHigh ? '🛡️' : '✨'} {Math.round(item.confidence * 100)}% 匹配
                          </span>
                        </div>

                        <div
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-tertiary)',
                            marginTop: '4px',
                            display: 'flex',
                            gap: '12px',
                          }}
                        >
                          <span>本地检测: <strong>v{item.local_version}</strong></span>
                          <span>·</span>
                          <span>收录仓库: <code>{item.catalog_id}</code></span>
                        </div>

                        {(item.resolved_executable_path || item.scanned.install_location) && (
                          <div
                            style={{
                              fontSize: '11px',
                              color: 'var(--text-tertiary)',
                              fontFamily: 'monospace',
                              marginTop: '2px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={item.resolved_executable_path || item.scanned.install_location}
                          >
                            {item.resolved_executable_path
                              ? `🚀 运行程序: ${item.resolved_executable_path}`
                              : `📂 安装目录: ${item.scanned.install_location}`}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-acrylic)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-acrylic-thin)',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            💡 纳管后可随时在「可更新」视图检测并一键静默升级
          </span>
          <div style={{ display: 'flex', gap: '10px' }}>
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
              style={{ padding: '6px 20px', fontSize: '13px', fontWeight: 600 }}
            >
              {isImporting ? '正在纳管...' : `一键纳管已选应用 (${selectedIds.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
