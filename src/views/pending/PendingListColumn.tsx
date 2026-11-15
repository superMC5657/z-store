/**
 * 待收录页左列：Master 列表。
 * 只渲染调用方已按 Tab 与全局设备平台筛选过滤后的条目。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox, Link2 } from 'lucide-react';
import { AppIconFrame } from '../../components/AppIconFrame';
import {
  resolvePendingDraftDescription,
  type CustomDraftEntry,
  type PendingGroupId,
} from './draftModel';

interface PendingListColumnProps {
  /** 当前 Tab + 平台筛选后的可见条目。 */
  entries: CustomDraftEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  activeGroup: PendingGroupId;
  /** 当前 Tab 有条目但全部被平台筛选隐藏：展示平台筛选空态与重置动作。 */
  hiddenByPlatformFilter: boolean;
  onResetPlatformFilter: () => void;
}

export const PendingListColumn: React.FC<PendingListColumnProps> = ({
  entries,
  selectedId,
  onSelect,
  activeGroup,
  hiddenByPlatformFilter,
  onResetPlatformFilter,
}) => {
  const { t, i18n } = useTranslation();

  return (
    <div className="pending-list" role="tabpanel" aria-label={t(`pending.groups.${activeGroup}`)}>
      {entries.length === 0 ? (
        <div className="pending-list-empty-inline">
          <Inbox size={22} strokeWidth={1.25} aria-hidden="true" style={{ opacity: 0.5 }} />
          <div style={{ fontWeight: 510, color: 'var(--text-secondary)' }}>
            {hiddenByPlatformFilter
              ? t('pending.platform_empty_title')
              : t(`pending.group_empty.${activeGroup}.title`)}
          </div>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
            {hiddenByPlatformFilter
              ? t('pending.platform_empty_desc')
              : t(`pending.group_empty.${activeGroup}.desc`)}
          </div>
          {hiddenByPlatformFilter && (
            <button
              type="button"
              className="btn-fluent btn-secondary filter-empty-reset"
              data-testid="pending-platform-reset"
              onClick={onResetPlatformFilter}
            >
              {t('pending.platform_empty_reset')}
            </button>
          )}
        </div>
      ) : (
        entries.map((entry) => {
          const selected = entry.id === selectedId;
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
              <AppIconFrame
                icon={entry.item.icon}
                name={entry.item.name || entry.id}
                appId={entry.id}
                iconBg={entry.item.icon_bg || undefined}
                className="pending-item-icon"
                size="sm"
                selected={selected}
              />
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
    </div>
  );
};
