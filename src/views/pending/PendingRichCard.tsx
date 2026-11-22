/** 待收录页右侧只读富卡：展示已收录/已提交/已归档条目及对应状态操作。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Link2, PackageCheck, Send, Trash2, Undo2 } from 'lucide-react';
import { AppCard } from '../../components/AppCard';
import { InlineConfirmButton } from '../../components/InlineConfirmButton';
import type { AppSummary } from '../../types';
import {
  errorText,
  isPendingCollectedStatus,
  isSubmittedEntry,
  type CustomDraftEntry,
  type PendingDraftErrors,
} from './draftModel';

const NOOP = () => {};

interface PendingRichCardProps {
  /** 当前选中条目（富卡分支保证非空）。 */
  entry: CustomDraftEntry;
  /** 富卡投影（pendingDraftToAppSummary 产物）。 */
  cardApp: AppSummary & { status: string; archived?: boolean };
  /** 富卡态内联口径：live（快照）与提交尝试（formErrors，真实门禁）合并结果。 */
  inlineErrors: PendingDraftErrors;
  prUrlInput: string;
  onPrUrlInput: (value: string) => void;
  onMarkSubmitted: (id: string) => void;
  submittingId: string | null;
  onSubmitPr: (id: string) => void;
  hasSubmitErrors: boolean;
  hasLicenseSubmitError: boolean;
  revertingId: string | null;
  /** 二次确认后执行（确认态由 `InlineConfirmButton` 持有）。 */
  onRevertToDraft: (id: string) => void;
  withdrawingId: string | null;
  /** 二次确认后执行。 */
  onWithdrawSubmitted: (id: string) => void;
  /** 二次确认后执行。 */
  onDelete: (id: string) => void;
  onDuplicate: () => void;
}

export const PendingRichCard: React.FC<PendingRichCardProps> = ({
  entry,
  cardApp,
  inlineErrors,
  prUrlInput,
  onPrUrlInput,
  onMarkSubmitted,
  submittingId,
  onSubmitPr,
  hasSubmitErrors,
  hasLicenseSubmitError,
  revertingId,
  onRevertToDraft,
  withdrawingId,
  onWithdrawSubmitted,
  onDelete,
  onDuplicate,
}) => {
  const { t } = useTranslation();

  return (
    <div className="app-card pending-editor-card">
      {/* 富卡头：标题 + 分组徽标（无坐标显隐开关，富卡即全量） */}
      <div className="pending-editor-header">
        <div className="pending-editor-title-wrap">
          {entry.archived ? (
            <Archive size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          ) : isSubmittedEntry(entry) ? (
            <Send size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          ) : (
            <PackageCheck size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          )}
          <strong
            className="pending-editor-title"
            title={entry.id}
          >
            {entry.id}
          </strong>
          {entry.archived ? (
            <span className="status-tag" title={t('pending.archived_badge')}>
              {t('pending.archived_badge')}
            </span>
          ) : isSubmittedEntry(entry) ? (
            <span className="status-tag" style={{ color: 'var(--brand-primary)', borderColor: 'var(--brand-glow)' }}>
              {t('pending.groups.submitted')}
            </span>
          ) : (
            <span className="status-tag" title={t('pending.groups.library')}>
              {t('pending.groups.library')}
            </span>
          )}
        </div>
      </div>

      {/* 富卡主体：复用 AppCard（source=local 即黄标），纯预览态保持关注与收藏占位，点击无副作用 */}
      <div style={{ marginBottom: '12px' }}>
        <AppCard
          app={cardApp}
          isInstalled={false}
          isManaged={false}
          platformLoading={false}
          onOpenDetail={NOOP}
          onQuickInstall={NOOP}
          onToggleFavorite={NOOP}
          onToggleWatch={NOOP}
        />
      </div>

      {/* 富卡内联拦阻（与表单同 testid 口径，提交/收录前缺项即显） */}
      {Object.keys(inlineErrors).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
          {(Object.entries(inlineErrors) as Array<[string, string | undefined]>).map(([key, code]) =>
            code ? (
              <em key={key} data-testid={`pending-error-${key}`} className="pending-field-error">
                {errorText(t, code)}
              </em>
            ) : null,
          )}
        </div>
      )}

      {/* 富卡底部：collected=提交 Issue 主/退回次，submitted=Issue 链接+删除，archived=只读+复制为新草稿 */}
      <div className="pending-editor-footer">
        <div className="pending-editor-footer-actions">
          {!entry.archived && isSubmittedEntry(entry) && (
            <InlineConfirmButton
              size="sm"
              testId="pending-withdraw-submitted"
              confirmVariant="warning"
              disabled={withdrawingId === entry.id}
              onConfirm={() => onWithdrawSubmitted(entry.id)}
              confirmText={t('pending.confirm_withdraw')}
              title={t('pending.withdraw_hint', { id: entry.id })}
            >
              <Undo2 size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {withdrawingId === entry.id ? t('pending.withdrawing') : t('pending.withdraw_submitted')}
              </span>
            </InlineConfirmButton>
          )}
          {!entry.archived && isSubmittedEntry(entry) && (
            <InlineConfirmButton
              size="sm"
              testId="pending-delete"
              onConfirm={() => onDelete(entry.id)}
              confirmText={t('pending.confirm_delete')}
              title={t('pending.delete_hint')}
              style={{ marginLeft: 'auto' }}
            >
              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>{t('pending.delete')}</span>
            </InlineConfirmButton>
          )}
          {!entry.archived && isPendingCollectedStatus(entry.status) && (
            <>
              <InlineConfirmButton
                size="sm"
                testId="pending-revert-to-draft"
                confirmVariant="warning"
                disabled={revertingId === entry.id}
                onConfirm={() => onRevertToDraft(entry.id)}
                confirmText={t('pending.confirm_revert')}
                title={t('pending.revert_hint', { id: entry.id })}
                style={{ marginLeft: 'auto' }}
              >
                <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('pending.revert_to_draft')}</span>
              </InlineConfirmButton>
              <button
                type="button"
                className="btn-fluent btn-primary btn-sm"
                data-testid="pending-submit-pr"
                disabled={submittingId === entry.id}
                onClick={() => void onSubmitPr(entry.id)}
                title={
                  hasSubmitErrors
                    ? hasLicenseSubmitError
                      ? t('pending.pr.license_fix_hint', { id: entry.id })
                      : t('pending.fix_errors')
                    : t('pending.pr.prefill_hint')
                }
              >
                <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>
                  {submittingId === entry.id
                    ? t('pending.pr.submitting')
                    : t('pending.pr.submit_pr')}
                </span>
              </button>
            </>
          )}
        </div>

        {/* 已提交展 Issue 链接与删除；已收录展手动标记行；已归档只读 */}
        {!entry.archived && isPendingCollectedStatus(entry.status) && (
          <div className="pending-editor-footer-manual">
            <div className="pending-manual-label">{t('pending.submit_title')}</div>
            <div className="pending-manual-row">
              <input
                className="input-fluent"
                style={{ flex: '1 1 200px' }}
                value={prUrlInput}
                onChange={(e) => onPrUrlInput(e.target.value)}
                placeholder="https://github.com/…/pull/…"
                inputMode="url"
                spellCheck={false}
                aria-label={t('pending.submit_title')}
              />
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                onClick={() => onMarkSubmitted(entry.id)}
              >
                <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('pending.mark_submitted')}</span>
              </button>
            </div>
            {entry.pr_url && (
              <div className="pending-editor-pr-link">
                <Link2 size={12} strokeWidth={1.5} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
                <a
                  href={entry.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  title={t('pending.pr.open_pr')}
                  aria-label={t('pending.pr.open_pr')}
                >
                  {entry.pr_url}
                </a>
              </div>
            )}
          </div>
        )}
        {!entry.archived && entry.status === 'submitted' && entry.pr_url && (
          <div className="pending-editor-footer-manual">
            <div className="pending-editor-pr-link">
              <Link2 size={12} strokeWidth={1.5} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
              <a
                href={entry.pr_url}
                target="_blank"
                rel="noreferrer"
                title={t('pending.pr.open_pr')}
                aria-label={t('pending.pr.open_pr')}
              >
                {entry.pr_url}
              </a>
            </div>
          </div>
        )}
        {entry.archived && (
          <div className="pending-editor-footer-manual">
            {entry.pr_url && (
              <div className="pending-editor-pr-link">
                <Link2 size={12} strokeWidth={1.5} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
                <a
                  href={entry.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  title={t('pending.pr.open_pr')}
                  aria-label={t('pending.pr.open_pr')}
                >
                  {entry.pr_url}
                </a>
              </div>
            )}
            <div className="pending-manual-row">
              <span className="pending-archived-hint">
                {t('pending.archived_readonly_hint')}
              </span>
              <button
                type="button"
                className="btn-fluent btn-secondary btn-sm"
                data-testid="pending-duplicate"
                onClick={onDuplicate}
              >
                <span>{t('pending.duplicate_as_new_draft')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
