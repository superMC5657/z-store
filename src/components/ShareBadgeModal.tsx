import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, X } from 'lucide-react';
import '../i18n';
import { ModalShell, type ModalLayer } from './ModalShell';
import { SegmentedControl } from './SegmentedControl';
import { useTransientFeedback } from './useTransientFeedback';
import { copyTextToClipboard } from '../utils/appHelper';
import {
  buildShareBadgeArtifacts,
  type ShareBadgeKind,
  type ShareBadgeLinkTarget,
  type ShareBadgeStyle,
} from '../utils/shareBadge';

export interface ShareBadgeModalProps {
  id: string;
  name: string;
  kind: ShareBadgeKind;
  layer?: ModalLayer;
  onClose: () => void;
}

type SnippetKey = 'deeplink' | 'markdown' | 'html';
type CopiedKind = SnippetKey | null;

export const ShareBadgeModal: React.FC<ShareBadgeModalProps> = ({
  id,
  name,
  kind,
  layer = 'base',
  onClose,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const [style, setStyle] = useState<ShareBadgeStyle>('dark');
  const [linkTarget, setLinkTarget] = useState<ShareBadgeLinkTarget>('landing');
  const [copiedKind, setCopiedKind] = useState<CopiedKind>(null);
  const feedback = useTransientFeedback(3000);

  const artifacts = useMemo(
    () => buildShareBadgeArtifacts({ id, name, kind, style, linkTarget }),
    [id, name, kind, style, linkTarget],
  );

  const styleOptions = [
    { value: 'dark' as const, label: t('share_badge.style_dark') },
    { value: 'light' as const, label: t('share_badge.style_light') },
  ];

  const linkTargetOptions = [
    { value: 'landing' as const, label: t('share_badge.link_target_landing') },
    { value: 'deeplink' as const, label: t('share_badge.link_target_deeplink') },
  ];

  const handleCopy = async (snippetKey: SnippetKey, value: string) => {
    const ok = await copyTextToClipboard(value);
    if (ok) {
      setCopiedKind(snippetKey);
      feedback.show(t('share_badge.copied'), false);
    } else {
      setCopiedKind(null);
      feedback.show(t('share_badge.copy_failed'), true);
    }
  };

  const snippets: Array<{
    key: SnippetKey;
    label: string;
    hint: string;
    value: string;
  }> = [
    {
      key: 'deeplink',
      label: t('share_badge.deeplink_label'),
      hint: t('share_badge.deeplink_hint'),
      value: artifacts.deepLinkUrl,
    },
    {
      key: 'markdown',
      label: t('share_badge.markdown_label'),
      hint: t('share_badge.markdown_hint'),
      value: artifacts.markdownSnippet,
    },
    {
      key: 'html',
      label: t('share_badge.html_label'),
      hint: t('share_badge.html_hint'),
      value: artifacts.htmlSnippet,
    },
  ];

  const displayTitle = name.trim() || id;

  return (
    <ModalShell
      layer={layer}
      onClose={onClose}
      panelClassName="share-badge-modal"
      ariaLabelledBy={titleId}
    >
      <div className="share-badge-header">
        <div className="share-badge-heading">
          <h3 id={titleId}>{t('share_badge.title')}</h3>
          <p>{t('share_badge.subtitle')}</p>
        </div>
        <button
          type="button"
          className="modal-header-btn"
          onClick={onClose}
          aria-label={t('share_badge.close')}
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <div className="modal-body share-badge-body">
        <div className="share-badge-style-row">
          <span className="share-badge-style-label">{t('share_badge.style_label')}</span>
          <SegmentedControl<ShareBadgeStyle>
            value={style}
            onChange={setStyle}
            options={styleOptions}
            size="compact"
            ariaLabel={t('share_badge.style_label')}
          />
        </div>

        <div className="share-badge-style-row">
          <span className="share-badge-style-label">{t('share_badge.link_target_label')}</span>
          <SegmentedControl<ShareBadgeLinkTarget>
            value={linkTarget}
            onChange={setLinkTarget}
            options={linkTargetOptions}
            size="compact"
            ariaLabel={t('share_badge.link_target_label')}
          />
        </div>

        <div
          className={`share-badge-preview-box ${
            style === 'light' ? 'is-dark-surface' : 'is-light-surface'
          }`}
          aria-label={t('share_badge.preview_label')}
        >
          <span className="share-badge-pill" data-testid="share-badge-preview-pill" data-style={style}>
            <span className="share-badge-pill-label">ZStore</span>
            <span className={`share-badge-pill-value is-${style}`}>{id}</span>
          </span>
          <img
            className="share-badge-preview-img"
            src={artifacts.shieldsBadgeUrl}
            alt={t('share_badge.preview_alt', { name: displayTitle })}
            loading="lazy"
          />
        </div>

        {snippets.map((snippet) => {
          const isCopied = copiedKind === snippet.key;
          return (
            <div key={snippet.key} className="share-badge-snippet">
              <div className="share-badge-snippet-head">
                <span className="share-badge-snippet-title">{snippet.label}</span>
                <button
                  type="button"
                  className="btn-fluent btn-secondary btn-sm"
                  data-testid={`share-copy-${snippet.key}`}
                  onClick={() => void handleCopy(snippet.key, snippet.value)}
                >
                  {isCopied ? (
                    <Check size={12} strokeWidth={1.5} aria-hidden="true" />
                  ) : (
                    <Copy size={12} strokeWidth={1.5} aria-hidden="true" />
                  )}
                  <span>{isCopied ? t('share_badge.copied') : t('share_badge.copy')}</span>
                </button>
              </div>
              <p className="share-badge-snippet-hint">{snippet.hint}</p>
              <code className="share-badge-code" data-testid={`share-code-${snippet.key}`}>
                {snippet.value}
              </code>
            </div>
          );
        })}
      </div>

      <div className="modal-footer">
        {feedback.text && (
          <span
            className={`share-badge-feedback ${feedback.isError ? 'is-error' : ''}`}
            role="status"
          >
            {feedback.text}
          </span>
        )}
        <button type="button" className="btn-fluent btn-secondary" onClick={onClose}>
          {t('share_badge.close')}
        </button>
      </div>
    </ModalShell>
  );
};
