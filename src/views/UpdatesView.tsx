import React, { useState } from 'react';
import { UpdateItem } from '../types';

interface UpdatesViewProps {
  updates: UpdateItem[];
  onApplyUpdate: (id: string) => Promise<void>;
  onBatchUpdateAll: () => Promise<void>;
  onIgnoreUpdate?: (id: string) => void;
}

export const UpdatesView: React.FC<UpdatesViewProps> = ({
  updates,
  onApplyUpdate,
  onBatchUpdateAll,
  onIgnoreUpdate,
}) => {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleUpdate = async (id: string) => {
    try {
      setUpdatingId(id);
      await onApplyUpdate(id);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleUpdateAll = async () => {
    try {
      setIsUpdatingAll(true);
      await onBatchUpdateAll();
    } finally {
      setIsUpdatingAll(false);
    }
  };

  return (
    <div className="updates-view">
      <div className="section-header">
        <h3 className="section-title">🔄 可更新项管理 ({updates.length})</h3>
        {updates.length > 0 && (
          <button
            className="btn-fluent btn-primary"
            onClick={handleUpdateAll}
            disabled={isUpdatingAll}
            style={{ fontWeight: 600, fontSize: '13px' }}
          >
            {isUpdatingAll ? '正在批量更新中...' : `一键全部升级 (${updates.length} 个就绪)`}
          </button>
        )}
      </div>

      {updates.length === 0 ? (
        <div className="empty-state-card">
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>✨</div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>太棒了！所有应用均已是最新版本</h4>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
            Z-Store 基于 ETag 304 条件缓存静默轮询 GitHub Releases，在有新发布时将第一时间在此通知您。
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {updates.map((item) => {
            const isExpanded = expandedId === item.app_id;
            const isThisUpdating = updatingId === item.app_id;

            return (
              <div key={item.app_id} className="app-card" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h4 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>{item.app_name}</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>当前: {item.current_version}</span>
                      <span>➔</span>
                      <span style={{ color: 'var(--brand-primary)', fontWeight: 600 }}>
                        最新: {item.latest_version}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '6px 12px' }}
                      onClick={() => setExpandedId(isExpanded ? null : item.app_id)}
                    >
                      {isExpanded ? '收起更新日志' : '查看日志'}
                    </button>
                    {onIgnoreUpdate && (
                      <button
                        className="btn-fluent btn-secondary"
                        style={{ fontSize: '12px', padding: '6px 12px', color: 'var(--text-tertiary)' }}
                        onClick={() => onIgnoreUpdate(item.app_id)}
                        title="跳过此版本，不再提示"
                      >
                        忽略此版本
                      </button>
                    )}
                    <button
                      className="btn-fluent btn-primary"
                      style={{ fontSize: '13px', padding: '6px 16px', fontWeight: 600 }}
                      disabled={isThisUpdating || isUpdatingAll}
                      onClick={() => handleUpdate(item.app_id)}
                    >
                      {isThisUpdating ? '升级中...' : '立即升级'}
                    </button>
                  </div>
                </div>

                {isExpanded && item.changelog && (
                  <div
                    style={{
                      marginTop: '16px',
                      padding: '14px',
                      background: 'var(--bg-acrylic-thin)',
                      borderRadius: '8px',
                      border: '1px solid var(--border-acrylic)',
                      fontSize: '12px',
                      lineHeight: '1.6',
                      color: 'var(--text-secondary)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {item.changelog}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
