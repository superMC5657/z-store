import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { Bold, Code, Image as ImageIcon, Italic, Link, List, Quote, Send, Smile, X } from 'lucide-react';
import { notifyToast } from '../../useToasts';
import { CachedAvatar } from '../../components/CachedAvatar';
import {
  COMPOSER_EMOJIS,
  applyMarkdownFormat,
  insertText,
  type MarkdownFormat,
  type TextEdit,
} from './discussionFormat';
import { DiscussionMarkdown } from './DiscussionMarkdown';

export interface DiscussionComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  onSend: () => void;
  viewerLogin?: string;
  viewerAvatar?: string;
  replyToLogin?: string | null;
  replyKey?: number;
  onCancelReply: () => void;
}

const MAX_CHARS = 10_000;

type Popover = 'emoji' | 'image' | null;

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export const DiscussionComposer: React.FC<DiscussionComposerProps> = ({
  draft,
  onDraftChange,
  sending,
  onSend,
  viewerLogin,
  viewerAvatar,
  replyToLogin,
  replyKey,
  onCancelReply,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const tabsId = useId();
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [popover, setPopover] = useState<Popover>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageAlt, setImageAlt] = useState('');
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  // 回复目标切换时聚焦输入框，便于直接输入。
  useEffect(() => {
    if (replyToLogin != null) {
      setMode('write');
      inputRef.current?.focus();
    }
  }, [replyToLogin, replyKey]);

  // 受控值更新后恢复选区（格式化 / 插入表情后光标落点）。
  useEffect(() => {
    const sel = pendingSelection.current;
    const el = inputRef.current;
    if (!sel || !el) return;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(sel.start, sel.end);
  }, [draft, mode]);

  useEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.('[data-composer-popover-trigger]')) return;
      setPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popover]);

  const selection = () => {
    const el = inputRef.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: draft.length, end: draft.length };
  };

  const commit = (edit: TextEdit) => {
    pendingSelection.current = { start: edit.selectionStart, end: edit.selectionEnd };
    setMode('write');
    onDraftChange(edit.value.slice(0, MAX_CHARS));
  };

  const format = (kind: MarkdownFormat) => {
    const { start, end } = selection();
    const placeholder =
      kind === 'link' ? t('launchpad.md_link_text') : kind === 'code' ? 'code' : t('launchpad.md_placeholder');
    commit(applyMarkdownFormat(draft, start, end, kind, placeholder));
  };

  const insertEmoji = (emoji: string) => {
    const { start, end } = selection();
    commit(insertText(draft, start, end, emoji));
    setPopover(null);
  };

  const insertImage = () => {
    if (!isHttpUrl(imageUrl)) {
      notifyToast(t('launchpad.image_url_invalid'), 'warning');
      return;
    }
    const { start, end } = selection();
    const alt = imageAlt.trim() || t('launchpad.image_alt_default');
    const prefix = start > 0 && draft[start - 1] !== '\n' ? '\n' : '';
    commit(insertText(draft, start, end, `${prefix}![${alt}](${imageUrl.trim()})\n`));
    setImageUrl('');
    setImageAlt('');
    setPopover(null);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      notifyToast(t('launchpad.image_paste_unsupported'), 'info');
      setPopover('image');
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSend();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'b' || key === 'i') {
        e.preventDefault();
        format(key === 'b' ? 'bold' : 'italic');
      }
    }
  };

  const toolButton = (kind: MarkdownFormat, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      className="launchpad-tool-btn"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => format(kind)}
    >
      {icon}
    </button>
  );

  const canSend = !sending && draft.trim().length > 0;

  return (
    <div className="launchpad-composer">
      {replyToLogin != null && (
        <div className="launchpad-replying">
          <span>{t('launchpad.replying_to', { login: replyToLogin })}</span>
          <button
            type="button"
            className="btn-fluent btn-ghost btn-compact btn-icon-only"
            aria-label={t('launchpad.cancel_reply')}
            title={t('launchpad.cancel_reply')}
            onClick={onCancelReply}
          >
            <X size={12} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="launchpad-composer-row">
        {viewerLogin && (
          <span className="launchpad-composer-avatar" aria-hidden="true">
            <CachedAvatar src={viewerAvatar ?? ''} login={viewerLogin} size={28} />
          </span>
        )}
        <div className={`launchpad-composer-box${popover ? ' has-popover' : ''}`}>
          <div className="launchpad-composer-toolbar">
            <div className="launchpad-composer-tabs" role="tablist" aria-label={t('launchpad.composer_mode')}>
              <button
                type="button"
                role="tab"
                id={`${tabsId}-write`}
                aria-selected={mode === 'write'}
                className={mode === 'write' ? 'active' : ''}
                onClick={() => setMode('write')}
              >
                {t('launchpad.composer_write')}
              </button>
              <button
                type="button"
                role="tab"
                id={`${tabsId}-preview`}
                aria-selected={mode === 'preview'}
                className={mode === 'preview' ? 'active' : ''}
                onClick={() => setMode('preview')}
              >
                {t('launchpad.composer_preview')}
              </button>
            </div>
            <div className="launchpad-composer-tools" role="toolbar" aria-label={t('launchpad.composer_toolbar')}>
              {toolButton('bold', <Bold size={14} strokeWidth={1.5} aria-hidden="true" />, t('launchpad.md_bold'))}
              {toolButton('italic', <Italic size={14} strokeWidth={1.5} aria-hidden="true" />, t('launchpad.md_italic'))}
              {toolButton('code', <Code size={14} strokeWidth={1.5} aria-hidden="true" />, t('launchpad.md_code'))}
              {toolButton('link', <Link size={14} strokeWidth={1.5} aria-hidden="true" />, t('launchpad.md_link'))}
              {toolButton('quote', <Quote size={14} strokeWidth={1.5} aria-hidden="true" />, t('launchpad.md_quote'))}
              {toolButton('list', <List size={14} strokeWidth={1.5} aria-hidden="true" />, t('launchpad.md_list'))}
              <span className="launchpad-tool-sep" aria-hidden="true" />
              <button
                type="button"
                className={`launchpad-tool-btn${popover === 'image' ? ' active' : ''}`}
                data-composer-popover-trigger
                title={t('launchpad.md_image')}
                aria-label={t('launchpad.md_image')}
                aria-expanded={popover === 'image'}
                onClick={() => setPopover((p) => (p === 'image' ? null : 'image'))}
              >
                <ImageIcon size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`launchpad-tool-btn${popover === 'emoji' ? ' active' : ''}`}
                data-composer-popover-trigger
                data-testid="launchpad-emoji-toggle"
                title={t('launchpad.md_emoji')}
                aria-label={t('launchpad.md_emoji')}
                aria-expanded={popover === 'emoji'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPopover((p) => (p === 'emoji' ? null : 'emoji'))}
              >
                <Smile size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
          </div>

          {mode === 'write' ? (
            <textarea
              ref={inputRef}
              className="launchpad-composer-input"
              data-testid="launchpad-comment-input"
              value={draft}
              maxLength={MAX_CHARS}
              placeholder={t('launchpad.comment_placeholder')}
              aria-label={t('launchpad.comment_placeholder')}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          ) : (
            <div className="launchpad-composer-preview" data-testid="launchpad-comment-preview">
              {draft.trim() ? (
                <DiscussionMarkdown body={draft} />
              ) : (
                <p className="launchpad-modal-muted">{t('launchpad.preview_empty')}</p>
              )}
            </div>
          )}

          {popover === 'emoji' && (
            <div
              ref={popoverRef}
              className="launchpad-composer-popover launchpad-emoji-grid"
              role="listbox"
              aria-label={t('launchpad.md_emoji')}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setPopover(null);
                }
              }}
            >
              {COMPOSER_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="launchpad-emoji-btn"
                  aria-label={emoji}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertEmoji(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          {popover === 'image' && (
            <div
              ref={popoverRef}
              className="launchpad-composer-popover launchpad-image-form"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setPopover(null);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  insertImage();
                }
              }}
            >
              <label>
                <span>{t('launchpad.image_url')}</span>
                <input
                  type="url"
                  autoFocus
                  data-testid="launchpad-image-url"
                  value={imageUrl}
                  placeholder="https://"
                  onChange={(e) => setImageUrl(e.target.value)}
                />
              </label>
              <label>
                <span>{t('launchpad.image_alt')}</span>
                <input
                  type="text"
                  value={imageAlt}
                  placeholder={t('launchpad.image_alt_default')}
                  onChange={(e) => setImageAlt(e.target.value)}
                />
              </label>
              <p className="launchpad-image-hint">{t('launchpad.image_hint')}</p>
              <div className="launchpad-image-actions">
                <button type="button" className="btn-fluent btn-ghost btn-compact" onClick={() => setPopover(null)}>
                  {t('launchpad.cancel')}
                </button>
                <button
                  type="button"
                  className="btn-fluent btn-primary btn-compact"
                  data-testid="launchpad-image-insert"
                  disabled={!imageUrl.trim()}
                  onClick={insertImage}
                >
                  {t('launchpad.image_insert')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="launchpad-composer-foot">
        <span className="launchpad-composer-hint">{t('launchpad.composer_hint')}</span>
        <button
          type="button"
          className="btn-fluent btn-primary btn-compact"
          data-testid="launchpad-comment-send"
          disabled={!canSend}
          onClick={onSend}
        >
          <Send size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{replyToLogin != null ? t('launchpad.send_reply') : t('launchpad.send_comment')}</span>
        </button>
      </div>
    </div>
  );
};
