import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, Link2, Search, X } from 'lucide-react';
import '../i18n';
import type { AppSummary } from '../types';
import { matchesAppText } from '../app/selectors';
import { canonicalAppId, normalizeId } from '../services/normalizeId';
import { copyTextToClipboard } from '../utils/appHelper';
import {
  COLLECTION_DEFAULT_PRESELECT,
  COLLECTION_MAX_APPS,
  COLLECTION_MAX_DEEPLINK_LEN,
  COLLECTION_NOTE_MAX_CHARS,
  COLLECTION_TITLE_MAX_CHARS,
  buildCollectionDeepLink,
  buildCollectionMarkdown,
} from '../utils/collectionShare';
import { AppIconFrame } from './AppIconFrame';
import { CountBadge } from './CountBadge';
import { ModalShell } from './ModalShell';
import { useTransientFeedback } from './useTransientFeedback';

export interface CollectionShareModalProps {
  apps: readonly AppSummary[];
  defaultTitle?: string;
  onClose: () => void;
}

type CopiedArtifact = 'deeplink' | 'markdown' | null;

interface CandidateItem {
  key: string;
  app: AppSummary;
}

function charLength(s: string): number {
  return Array.from(s).length;
}

export const CollectionShareModal: React.FC<CollectionShareModalProps> = ({
  apps,
  defaultTitle = '',
  onClose,
}) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const titleInputId = useId();
  const noteInputId = useId();

  const candidates = useMemo<CandidateItem[]>(() => {
    const seen = new Set<string>();
    const list: CandidateItem[] = [];
    for (const app of apps) {
      const key = canonicalAppId(app.id) ?? normalizeId(app.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push({ key, app: { ...app, id: key } });
    }
    return list;
  }, [apps]);

  const [title, setTitle] = useState(defaultTitle);
  const [note, setNote] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const item of candidates.slice(0, COLLECTION_DEFAULT_PRESELECT)) {
      initial.add(item.key);
    }
    return initial;
  });
  const [copiedKind, setCopiedKind] = useState<CopiedArtifact>(null);
  const feedback = useTransientFeedback(3000);

  const filteredCandidates = useMemo(() => {
    if (!searchQuery.trim()) return candidates;
    return candidates.filter((c) => matchesAppText(c.app, searchQuery));
  }, [candidates, searchQuery]);

  const selectedApps = useMemo(
    () => candidates.filter((c) => selectedIds.has(c.key)).map((c) => c.app),
    [candidates, selectedIds],
  );

  const limitReached = selectedIds.size >= COLLECTION_MAX_APPS;

  const deepLink = useMemo(
    () =>
      buildCollectionDeepLink({
        title,
        note,
        appIds: selectedApps.map((a) => a.id),
      }),
    [title, note, selectedApps],
  );

  const markdown = useMemo(
    () =>
      buildCollectionMarkdown({
        title,
        note,
        apps: selectedApps,
        deepLinkUrl: deepLink.exceedsMaxLen ? '' : deepLink.url,
        locale: i18n.language,
        fallbackHeading: t('collection.share.markdown_heading_fallback'),
      }),
    [title, note, selectedApps, deepLink.exceedsMaxLen, deepLink.url, i18n.language, t],
  );

  const handleToggleApp = (key: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      if (next.size >= COLLECTION_MAX_APPS) return prev;
      next.add(key);
      return next;
    });
  };

  const handleSelectTop = () => {
    const next = new Set<string>();
    for (const item of filteredCandidates) {
      next.add(item.key);
      if (next.size >= COLLECTION_MAX_APPS) break;
    }
    setSelectedIds(next);
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleCopy = async (kind: Exclude<CopiedArtifact, null>, value: string) => {
    if (!value) return;
    const ok = await copyTextToClipboard(value);
    if (ok) {
      setCopiedKind(kind);
      feedback.show(
        kind === 'deeplink'
          ? t('collection.share.copied_deeplink')
          : t('collection.share.copied_markdown'),
        false,
      );
    } else {
      setCopiedKind(null);
      feedback.show(t('collection.share.copy_failed'), true);
    }
  };

  const titleChars = charLength(title);
  const noteChars = charLength(note);

  return (
    <ModalShell
      layer="base"
      onClose={onClose}
      panelClassName="collection-modal"
      ariaLabelledBy={titleId}
    >
      <div className="collection-modal-header">
        <div className="collection-modal-heading">
          <h3 id={titleId} className="collection-modal-title-row">
            <span>{t('collection.share.title')}</span>
          </h3>
          <p className="collection-modal-subtitle">{t('collection.share.subtitle')}</p>
        </div>
        <button
          type="button"
          className="modal-header-btn"
          onClick={onClose}
          aria-label={t('collection.share.close')}
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <div className="modal-body collection-modal-body">
        <div className="collection-share-form">
          <div className="collection-field">
            <div className="collection-field-head">
              <label htmlFor={titleInputId}>{t('collection.share.title_label')}</label>
              <span className="collection-char-meter">
                {titleChars} / {COLLECTION_TITLE_MAX_CHARS}
              </span>
            </div>
            <input
              id={titleInputId}
              type="text"
              className="input-fluent"
              maxLength={COLLECTION_TITLE_MAX_CHARS}
              placeholder={t('collection.share.title_placeholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="collection-field">
            <div className="collection-field-head">
              <label htmlFor={noteInputId}>{t('collection.share.note_label')}</label>
              <span className="collection-char-meter">
                {noteChars} / {COLLECTION_NOTE_MAX_CHARS}
              </span>
            </div>
            <input
              id={noteInputId}
              type="text"
              className="input-fluent"
              maxLength={COLLECTION_NOTE_MAX_CHARS}
              placeholder={t('collection.share.note_placeholder')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <div className="collection-picker-header">
          <div className="collection-picker-title">
            <span>{t('collection.share.apps_label')}</span>
            <CountBadge value={selectedIds.size} />
            <span className="collection-picker-limit">
              {limitReached
                ? t('collection.share.limit_reached', { max: COLLECTION_MAX_APPS })
                : t('collection.share.max_hint', { max: COLLECTION_MAX_APPS })}
            </span>
          </div>
          <div className="collection-picker-controls">
            <div className="fluent-input-search" style={{ minWidth: '180px' }}>
              <Search size={13} strokeWidth={1.5} aria-hidden="true" />
              <input
                type="text"
                placeholder={t('collection.share.search_placeholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              disabled={filteredCandidates.length === 0}
              onClick={handleSelectTop}
            >
              {t('collection.share.select_top', { max: COLLECTION_MAX_APPS })}
            </button>
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              disabled={selectedIds.size === 0}
              onClick={handleClearSelection}
            >
              {t('collection.share.clear')}
            </button>
          </div>
        </div>

        <div className="collection-picker-list">
          {candidates.length === 0 ? (
            <p className="collection-modal-subtitle">{t('collection.share.empty_candidates')}</p>
          ) : filteredCandidates.length === 0 ? (
            <p className="collection-modal-subtitle">{t('collection.share.empty_search')}</p>
          ) : (
            filteredCandidates.map(({ key, app }) => {
              const isChecked = selectedIds.has(key);
              const isDisabled = !isChecked && limitReached;
              return (
                <label
                  key={key}
                  className={`collection-picker-row ${isDisabled ? 'is-disabled' : ''}`.trim()}
                >
                  <input
                    type="checkbox"
                    className="collection-checkbox"
                    checked={isChecked}
                    disabled={isDisabled}
                    onChange={() => handleToggleApp(key)}
                    aria-label={app.name}
                  />
                  <AppIconFrame
                    size="sm"
                    icon={app.icon}
                    name={app.name}
                    appId={app.id}
                    iconBg={app.icon_bg}
                  />
                  <div className="collection-row-main">
                    <div className="collection-row-top">
                      <span className="collection-row-name-btn" style={{ cursor: 'inherit', textDecoration: 'none' }}>
                        {app.name}
                      </span>
                      <span className="collection-row-repo">{app.id}</span>
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>

        <div className="collection-preview-box">
          <div className="collection-field-head">
            <span>{t('collection.share.deeplink_label')}</span>
            <span className="collection-char-meter">
              {t('collection.share.length_counter', {
                length: deepLink.length,
                max: COLLECTION_MAX_DEEPLINK_LEN,
              })}
            </span>
          </div>
          <code className="share-badge-code" data-testid="collection-deeplink-preview">
            {deepLink.url || 'zstore://collection?ids=...'}
          </code>
          {(deepLink.exceedsMaxLen || deepLink.nearMaxLen) && (
            <div
              className={`collection-length-warning ${deepLink.exceedsMaxLen ? 'is-exceeded' : ''}`.trim()}
              data-testid="collection-length-warning"
            >
              <AlertTriangle size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {deepLink.exceedsMaxLen
                  ? t('collection.share.length_exceeded')
                  : t('collection.share.length_near_limit')}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="modal-footer collection-footer">
        <div className="collection-footer-left">
          {feedback.text && (
            <span
              className={`share-badge-feedback ${feedback.isError ? 'is-error' : ''}`.trim()}
              role="status"
            >
              {feedback.text}
            </span>
          )}
        </div>
        <div className="collection-footer-right">
          <button
            type="button"
            className="btn-fluent btn-secondary btn-compact"
            data-testid="collection-copy-markdown"
            disabled={selectedApps.length === 0}
            onClick={() => void handleCopy('markdown', markdown)}
          >
            {copiedKind === 'markdown' ? (
              <Check size={13} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Copy size={13} strokeWidth={1.5} aria-hidden="true" />
            )}
            <span>{t('collection.share.copy_markdown')}</span>
          </button>
          <button
            type="button"
            className="btn-fluent btn-primary btn-compact"
            data-testid="collection-copy-deeplink"
            disabled={selectedApps.length === 0 || deepLink.exceedsMaxLen}
            onClick={() => void handleCopy('deeplink', deepLink.url)}
          >
            {copiedKind === 'deeplink' ? (
              <Check size={13} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Link2 size={13} strokeWidth={1.5} aria-hidden="true" />
            )}
            <span>{t('collection.share.copy_deeplink')}</span>
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
