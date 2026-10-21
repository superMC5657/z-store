/**
 * 待收录页左列：Master 列表（含行内批量多选与底部批量提交工具行）。
 * 从 PendingView 拆出的表单段子组件之一，行为与拆分前逐行同口径。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, FilePlus2, Inbox, Link2, PackageCheck, Send } from 'lucide-react';
import {
  entryGroup,
  isPendingCollectedStatus,
  isSubmittedEntry,
  resolvePendingDraftDescription,
  type CustomDraftEntry,
  type PendingGroupId,
  type PendingSegmentId,
} from './draftModel';

interface PendingListColumnProps {
  /** 当前 Tab + 分段过滤后的可见条目。 */
  entries: CustomDraftEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  activeGroup: PendingGroupId;
  activeSegment: PendingSegmentId;
  /** 列表多选可用性（showBatchBar && library && 非 submitted 分段）。 */
  showBatchSelection: boolean;
  batchSelected: Set<string>;
  onToggleBatchSelected: (id: string) => void;
  batchBusy: boolean;
  batchPickedCount: number;
  hasBatchErrors: boolean;
  batchLicenseErrorId: string | null;
  onBatchSubmit: () => void;
}

export const PendingListColumn: React.FC<PendingListColumnProps> = ({
  entries,
  selectedId,
  onSelect,
  activeGroup,
  activeSegment,
  showBatchSelection,
  batchSelected,
  onToggleBatchSelected,
  batchBusy,
  batchPickedCount,
  hasBatchErrors,
  batchLicenseErrorId,
  onBatchSubmit,
}) => {
  const { t, i18n } = useTranslation();

  return (
    <div className="pending-list" role="tabpanel" aria-label={t(`pending.groups.${activeGroup}`)}>
      {entries.length === 0 ? (
        <div className="pending-list-empty-inline">
          <Inbox size={22} strokeWidth={1.25} aria-hidden="true" style={{ opacity: 0.5 }} />
          <div style={{ fontWeight: 510, color: 'var(--text-secondary)' }}>
            {activeGroup === 'library'
              ? t(`pending.segments.empty_title.${activeSegment}`)
              : t('pending.group_empty_title')}
          </div>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
            {activeGroup === 'library'
              ? t(`pending.segments.empty_desc.${activeSegment}`)
              : t('pending.group_empty_desc')}
          </div>
        </div>
      ) : (
        entries.map((entry) => {
          const selected = entry.id === selectedId;
          const group = entryGroup(entry);
          const isSubmitted = isSubmittedEntry(entry);
          const isArchived = group === 'archived';
          const isCollected = !isArchived && !isSubmitted && isPendingCollectedStatus(entry.status);
          const batchChecked = batchSelected.has(entry.id);
          return (
            <div
              key={entry.id}
              className={`app-card pending-list-item ${selected ? 'selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={() => onSelect(entry.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(entry.id);
                }
              }}
            >
              {showBatchSelection && isCollected && (
                <input
                  type="checkbox"
                  checked={batchChecked}
                  onChange={() => onToggleBatchSelected(entry.id)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  aria-label={entry.id}
                  title={t('pending.pr.batch_selected', { count: batchSelected.size, defaultValue: `已选 ${batchSelected.size}` })}
                  style={{ flexShrink: 0 }}
                />
              )}
              <span className="pending-item-icon-box">
                {isArchived ? (
                  <Archive size={14} strokeWidth={1.5} aria-hidden="true" />
                ) : isSubmitted ? (
                  <Send size={14} strokeWidth={1.5} aria-hidden="true" />
                ) : isCollected ? (
                  <PackageCheck size={14} strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <FilePlus2 size={14} strokeWidth={1.5} aria-hidden="true" />
                )}
              </span>
              <div className="pending-item-content">
                <div className="pending-item-name">
                  {entry.item.name || entry.id}
                </div>
                <div className="pending-item-meta">
                  <span className="pending-item-id">{entry.id}</span>
                </div>
                {(() => {
                  const listDesc = resolvePendingDraftDescription(entry.item, i18n.language);
                  return listDesc ? (
                    <div className="pending-item-desc" title={listDesc}>
                      {listDesc}
                    </div>
                  ) : (
                    <div className="pending-item-desc pending-preview-empty">{t('trends.no_desc')}</div>
                  );
                })()}
                {entry.pr_url && (
                  <div className="pending-item-pr-link">
                    <Link2 size={11} strokeWidth={1.5} aria-hidden="true" />
                    <a
                      href={entry.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      title={t('pending.pr.open_pr')}
                      aria-label={t('pending.pr.open_pr')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {entry.pr_url}
                    </a>
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
      {/* 列表底部工具行：批量提交专属位置（随本地收录 · 非已提交分段显隐，多选汇总/禁用/title 逻辑不变，右对齐单色） */}
      {showBatchSelection && (
        <div
          className="pending-list-toolbar"
          data-testid="pending-batch-toolbar"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: '8px', minHeight: '28px' }}
        >
          <button
            type="button"
            className="btn-fluent btn-primary btn-sm"
            data-testid="pending-batch-submit"
            disabled={batchBusy || batchPickedCount === 0}
            onClick={onBatchSubmit}
            title={
              hasBatchErrors
                ? batchLicenseErrorId
                  ? t('pending.pr.license_fix_hint', { id: batchLicenseErrorId })
                  : t('pending.fix_errors')
                : undefined
            }
          >
            <Send size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>
              {batchBusy
                ? t('pending.pr.batch_submitting')
                : t('pending.pr.batch_submit', { count: batchPickedCount })}
            </span>
          </button>
        </div>
      )}
    </div>
  );
};
