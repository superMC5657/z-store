/**
 * 待收录页右侧富卡（collected/submitted/archived 后链路只读展示 + 操作页脚）。
 * 从 PendingView 拆出的表单段子组件之一，行为与拆分前逐行同口径。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Link2, PackageCheck, Send, Trash2, Undo2 } from 'lucide-react';
import { AppCard } from '../../components/AppCard';
import type { AppSummary } from '../../types';
import {
  isPendingCollectedStatus,
  isSubmittedEntry,
  type CustomDraftEntry,
  type PendingDraftErrors,
} from './draftModel';
import { errorStyle } from './pendingStyles';

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
  confirmRevertId: string | null;
  onRevertToDraft: (id: string) => void;
  withdrawingId: string | null;
  confirmWithdrawId: string | null;
  onWithdrawSubmitted: (id: string) => void;
  /** 撤下入口开关（App 透传 onWithdrawSubmitted 才渲染）。 */
  hasWithdrawProvider: boolean;
  confirmDeleteId: string | null;
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
  confirmRevertId,
  onRevertToDraft,
  withdrawingId,
  confirmWithdrawId,
  onWithdrawSubmitted,
  hasWithdrawProvider,
  confirmDeleteId,
  onDelete,
  onDuplicate,
}) => {
  const { t } = useTranslation();
  const errorText = (code: string): string => t(`pending.errors.${code}`, code);

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
            <span className="nav-badge" title={t('pending.archived_badge')}>
              {t('pending.archived_badge')}
            </span>
          ) : isSubmittedEntry(entry) ? (
            <span className="nav-badge" style={{ color: 'var(--brand-primary)', borderColor: 'var(--brand-glow)' }}>
              {t('pending.segments.submitted')}
            </span>
          ) : (
            <span className="nav-badge" title={t('pending.groups.library')}>
              {t('pending.groups.library')}
            </span>
          )}
        </div>
      </div>

      {/* 富卡主体：复用 AppCard（source=local 即黄标），只读预览 */}
      <div style={{ marginBottom: '12px' }}>
        <AppCard
          app={cardApp}
          isInstalled={false}
          isManaged={false}
          platformLoading={false}
          onOpenDetail={() => {}}
          onQuickInstall={() => {}}
        />
      </div>

      {/* 富卡内联拦阻（与表单同 testid 口径，提交/收录前缺项即显） */}
      {Object.keys(inlineErrors).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
          {(Object.entries(inlineErrors) as Array<[string, string | undefined]>).map(([key, code]) =>
            code ? (
              <em key={key} data-testid={`pending-error-${key}`} style={errorStyle}>
                {errorText(code)}
              </em>
            ) : null,
          )}
        </div>
      )}

      {/* 富卡底部：collected=提交 Issue 主/退回次，submitted=Issue 链接+删除，archived=只读+复制为新草稿 */}
      <div className="pending-editor-footer">
        <div className="pending-editor-footer-actions">
          {hasWithdrawProvider && isSubmittedEntry(entry) && (
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              data-testid="pending-withdraw-submitted"
              disabled={withdrawingId === entry.id}
              onClick={() => void onWithdrawSubmitted(entry.id)}
              title={t('pending.withdraw_hint', { id: entry.id })}
            >
              <Undo2 size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {withdrawingId === entry.id
                  ? t('pending.withdrawing')
                  : confirmWithdrawId === entry.id
                    ? t('pending.confirm_withdraw')
                    : t('pending.withdraw_submitted')}
              </span>
            </button>
          )}
          {!entry.archived && isSubmittedEntry(entry) && (
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              data-testid="pending-delete"
              onClick={() => void onDelete(entry.id)}
              title={t('pending.delete_hint')}
              style={{ marginLeft: 'auto' }}
            >
              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {confirmDeleteId === entry.id ? t('pending.confirm_delete') : t('pending.delete')}
              </span>
            </button>
          )}
          {!entry.archived && isPendingCollectedStatus(entry.status) && (
            <>
              <button
                type="button"
                className="btn-fluent btn-secondary btn-sm"
                data-testid="pending-revert-to-draft"
                disabled={revertingId === entry.id}
                onClick={() => void onRevertToDraft(entry.id)}
                title={t('pending.revert_hint', { id: entry.id, defaultValue: '将本地收录退回草稿' })}
                style={{ marginLeft: 'auto' }}
              >
                <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>
                  {confirmRevertId === entry.id
                    ? t('pending.confirm_revert', { defaultValue: '再次点击确认退回' })
                    : t('pending.revert_to_draft', { defaultValue: '退回草稿' })}
                </span>
              </button>
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

        {/* 已提交展 Issue 链接 + 删除（不再重复提交）；已收录才展手动标记行；已归档只读 */}
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
                className="btn-fluent btn-secondary btn-sm"
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
                已归档草稿为只读，改名或修改请使用“复制为新草稿”
              </span>
              <button
                type="button"
                className="btn-fluent btn-secondary btn-sm"
                data-testid="pending-duplicate"
                onClick={onDuplicate}
                style={{ padding: '2px 8px', fontSize: '11px' }}
              >
                <span>复制为新草稿</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
