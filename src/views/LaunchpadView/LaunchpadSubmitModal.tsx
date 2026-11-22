import React, { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  SearchCheck,
  X,
  XCircle,
} from 'lucide-react';
import '../../i18n';
import { ModalShell } from '../../components/ModalShell';
import { tauriApi } from '../../services/api';
import { notifyToast } from '../../useToasts';
import { LaunchpadCard } from './LaunchpadCard';
import {
  LAUNCHPAD_CATEGORIES,
  MAKER_NOTE_MAX_LENGTH,
  buildLaunchpadIssueUrl,
  buildPreviewLaunchpadEntry,
  resolveIssueRepoUrl,
  validateCustomIconUrl,
  validateMakerNote,
  validateMakerNoteEn,
  type LaunchpadCategoryKey,
} from '../../utils/launchpadSubmit';
import type {
  LaunchpadPreflightResult,
  LaunchpadTier,
  OAuthUser,
} from '../../types';

export interface LaunchpadSubmitModalProps {
  submitIssueUrl?: string;
  oauthUser?: OAuthUser | null;
  onClose: () => void;
}

type FieldKey = 'repoUrl' | 'appName' | 'makerNote' | 'makerNoteEn' | 'customIconUrl';

function buildPreflightKey(repoUrl: string, customIconUrl: string): string {
  return `${repoUrl.trim()}||${customIconUrl.trim()}`;
}

export const LaunchpadSubmitModal: React.FC<LaunchpadSubmitModalProps> = ({
  submitIssueUrl,
  oauthUser = null,
  onClose,
}) => {
  const { t } = useTranslation();
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const repoInputId = `${baseId}-repo`;
  const repoHintId = `${baseId}-repo-hint`;
  const repoErrorId = `${baseId}-repo-error`;
  const appNameInputId = `${baseId}-name`;
  const appNameErrorId = `${baseId}-name-error`;
  const categorySelectId = `${baseId}-category`;
  const noteInputId = `${baseId}-note`;
  const noteHintId = `${baseId}-note-hint`;
  const noteErrorId = `${baseId}-note-error`;
  const noteEnInputId = `${baseId}-note-en`;
  const noteEnErrorId = `${baseId}-note-en-error`;
  const tierSelectId = `${baseId}-tier`;
  const iconInputId = `${baseId}-icon`;
  const iconHintId = `${baseId}-icon-hint`;
  const iconErrorId = `${baseId}-icon-error`;

  const [repoUrl, setRepoUrl] = useState('');
  const [appName, setAppName] = useState('');
  const [category, setCategory] = useState<LaunchpadCategoryKey>('dev');
  const [makerNote, setMakerNote] = useState('');
  const [makerNoteEn, setMakerNoteEn] = useState('');
  const [launchTier, setLaunchTier] = useState<LaunchpadTier>('free');
  const [customIconUrl, setCustomIconUrl] = useState('');

  const [touched, setTouched] = useState<Record<FieldKey, boolean>>({
    repoUrl: false,
    appName: false,
    makerNote: false,
    makerNoteEn: false,
    customIconUrl: false,
  });
  const [checking, setChecking] = useState(false);
  const [preflight, setPreflight] = useState<LaunchpadPreflightResult | null>(null);
  const [checkedKey, setCheckedKey] = useState('');
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const reqSeqRef = useRef(0);

  const repoInputRef = useRef<HTMLInputElement | null>(null);
  const appNameInputRef = useRef<HTMLInputElement | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const noteEnInputRef = useRef<HTMLInputElement | null>(null);
  const iconInputRef = useRef<HTMLInputElement | null>(null);

  const noteValidation = useMemo(() => validateMakerNote(makerNote), [makerNote]);
  const noteEnValidation = useMemo(() => validateMakerNoteEn(makerNoteEn), [makerNoteEn]);
  const iconValidation = useMemo(() => validateCustomIconUrl(customIconUrl), [customIconUrl]);

  const repoError = repoUrl.trim() === '' ? t('launchpad.wizard.err_repo_required') : null;
  const appNameError = appName.trim() === '' ? t('launchpad.wizard.err_app_name_required') : null;
  const noteError = noteValidation.ok
    ? null
    : noteValidation.error === 'newline'
      ? t('launchpad.wizard.err_note_newline')
      : noteValidation.error === 'too_long'
        ? t('launchpad.wizard.err_note_too_long')
        : t('launchpad.wizard.err_note_empty');
  const noteEnError = noteEnValidation.ok
    ? null
    : noteEnValidation.error === 'newline'
      ? t('launchpad.wizard.err_note_en_newline')
      : t('launchpad.wizard.err_note_en_too_long');
  const customIconError = iconValidation.ok ? null : t('launchpad.wizard.err_custom_icon_https');

  const showRepoError = touched.repoUrl && Boolean(repoError);
  const showAppNameError = touched.appName && Boolean(appNameError);
  const showNoteError =
    (touched.makerNote || noteValidation.hasNewline || noteValidation.length > MAKER_NOTE_MAX_LENGTH) &&
    Boolean(noteError);
  const showNoteEnError =
    (touched.makerNoteEn || noteEnValidation.hasNewline || noteEnValidation.length > MAKER_NOTE_MAX_LENGTH) &&
    Boolean(noteEnError);
  const showIconError = touched.customIconUrl && Boolean(customIconError);

  const currentKey = buildPreflightKey(repoUrl, customIconUrl);
  const preflightMatchesCurrent = preflight !== null && checkedKey === currentKey;
  const isPreflightPass = preflightMatchesCurrent && Boolean(preflight?.ok);
  const isStalePreflight = preflight !== null && checkedKey !== currentKey;

  const canSubmit =
    !checking &&
    isPreflightPass &&
    !repoError &&
    !appNameError &&
    noteValidation.ok &&
    noteEnValidation.ok &&
    iconValidation.ok;

  const markTouched = (field: FieldKey) => {
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  };

  const handleRunPreflight = async () => {
    markTouched('repoUrl');
    if (customIconUrl.trim()) markTouched('customIconUrl');
    if (repoError) {
      repoInputRef.current?.focus();
      return;
    }
    if (!iconValidation.ok) {
      iconInputRef.current?.focus();
      return;
    }

    const reqId = ++reqSeqRef.current;
    const targetRepo = repoUrl.trim();
    const targetIcon = customIconUrl.trim();
    const runKey = buildPreflightKey(targetRepo, targetIcon);
    setChecking(true);
    setPreflightError(null);

    try {
      const res = await tauriApi.preflightLaunchpadSubmission(
        targetRepo,
        targetIcon || undefined,
      );
      if (reqSeqRef.current !== reqId) return;
      setPreflight(res);
      setCheckedKey(runKey);
      if (res.repo_name && !appName.trim()) {
        setAppName(res.repo_name);
      }
    } catch (err) {
      if (reqSeqRef.current !== reqId) return;
      setPreflightError(String(err));
    } finally {
      if (reqSeqRef.current === reqId) {
        setChecking(false);
      }
    }
  };

  const previewEntry = useMemo(
    () =>
      buildPreviewLaunchpadEntry(
        {
          repoUrl: resolveIssueRepoUrl(repoUrl, preflightMatchesCurrent ? preflight : null),
          appName,
          category,
          makerNote,
          makerNoteEn,
          launchTier,
          customIconUrl,
        },
        preflightMatchesCurrent ? preflight : null,
        oauthUser,
      ),
    [
      repoUrl,
      appName,
      category,
      makerNote,
      makerNoteEn,
      launchTier,
      customIconUrl,
      preflightMatchesCurrent,
      preflight,
      oauthUser,
    ],
  );

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched({
      repoUrl: true,
      appName: true,
      makerNote: true,
      makerNoteEn: true,
      customIconUrl: true,
    });
    if (repoError) {
      repoInputRef.current?.focus();
      return;
    }
    if (appNameError) {
      appNameInputRef.current?.focus();
      return;
    }
    if (noteError) {
      noteInputRef.current?.focus();
      return;
    }
    if (noteEnError) {
      noteEnInputRef.current?.focus();
      return;
    }
    if (customIconError) {
      iconInputRef.current?.focus();
      return;
    }
    if (!isPreflightPass || !preflight) {
      return;
    }

    const effectiveIcon = preflight.resolved_icon_url || '';
    const issueUrl = buildLaunchpadIssueUrl(submitIssueUrl, {
      repoUrl: resolveIssueRepoUrl(repoUrl, preflight),
      appName: appName.trim() || preflight.repo_name || preflight.repo,
      category,
      makerNote: noteValidation.sanitized,
      makerNoteEn: noteEnValidation.sanitized,
      launchTier,
      customIconUrl: effectiveIcon,
    });
    void tauriApi.openUrl(issueUrl);
    onClose();
  };

  const categoryOptions = useMemo(
    () =>
      LAUNCHPAD_CATEGORIES.map((key) => ({
        key,
        label: `${key} · ${t(`categories.cat_${key}_name`)}`,
      })),
    [t],
  );

  const tierOptions: Array<{ value: LaunchpadTier; label: string }> = [
    { value: 'free', label: t('launchpad.wizard.tier_free') },
    { value: 'spotlight-7d', label: t('launchpad.wizard.tier_spotlight_7d') },
    { value: 'spotlight-14d', label: t('launchpad.wizard.tier_spotlight_14d') },
    { value: 'spotlight-30d', label: t('launchpad.wizard.tier_spotlight_30d') },
  ];

  const loggedInLogin = oauthUser && !oauthUser.is_expired ? oauthUser.login : null;

  const notifyPreviewDisabled = () => {
    notifyToast(t('launchpad.wizard.preview_disabled_notice'), 'info');
  };

  return (
    <ModalShell
      layer="base"
      onClose={onClose}
      panelClassName="launchpad-submit-modal"
      ariaLabelledBy={titleId}
    >
      <div className="launchpad-submit-header">
        <div className="launchpad-submit-heading">
          <h3 id={titleId}>{t('launchpad.wizard.title')}</h3>
          <p>{t('launchpad.wizard.subtitle')}</p>
        </div>
        <button
          type="button"
          className="modal-header-btn"
          onClick={onClose}
          aria-label={t('launchpad.close')}
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <form className="launchpad-submit-form-shell" onSubmit={handleSubmit} noValidate>
        <div className="launchpad-submit-body modal-scroll-area">
          <div className="launchpad-submit-col">
            <div className="launchpad-field">
              <div className="launchpad-field-head">
                <label htmlFor={repoInputId}>
                  {t('launchpad.wizard.repo_label')}
                  <span className="launchpad-field-required" aria-hidden="true">*</span>
                </label>
                {loggedInLogin && (
                  <button
                    type="button"
                    className="btn-fluent btn-secondary btn-sm"
                    data-testid="launchpad-wizard-fill-login"
                    onClick={() => {
                      setRepoUrl(`@${loggedInLogin}/`);
                      repoInputRef.current?.focus();
                    }}
                  >
                    {t('launchpad.wizard.quick_fill_login', { login: loggedInLogin })}
                  </button>
                )}
              </div>
              <span id={repoHintId} className="launchpad-field-hint">
                {t('launchpad.wizard.repo_hint')}
              </span>
              <input
                ref={repoInputRef}
                id={repoInputId}
                name="repo_url"
                type="text"
                className="launchpad-input"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onBlur={() => markTouched('repoUrl')}
                placeholder={t('launchpad.wizard.repo_placeholder')}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                aria-invalid={showRepoError ? 'true' : 'false'}
                aria-describedby={showRepoError ? `${repoHintId} ${repoErrorId}` : repoHintId}
              />
              {showRepoError && (
                <div id={repoErrorId} className="launchpad-field-error">
                  <XCircle size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span>{repoError}</span>
                </div>
              )}
            </div>

            <div className="launchpad-field">
              <label htmlFor={appNameInputId}>
                {t('launchpad.wizard.app_name_label')}
                <span className="launchpad-field-required" aria-hidden="true">*</span>
              </label>
              <input
                ref={appNameInputRef}
                id={appNameInputId}
                name="app_name"
                type="text"
                className="launchpad-input"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                onBlur={() => markTouched('appName')}
                placeholder={t('launchpad.wizard.app_name_placeholder')}
                maxLength={60}
                required
                aria-invalid={showAppNameError ? 'true' : 'false'}
                aria-describedby={showAppNameError ? appNameErrorId : undefined}
              />
              {showAppNameError && (
                <div id={appNameErrorId} className="launchpad-field-error">
                  <XCircle size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span>{appNameError}</span>
                </div>
              )}
            </div>

            <div className="launchpad-field">
              <label htmlFor={categorySelectId}>{t('launchpad.wizard.category_label')}</label>
              <select
                id={categorySelectId}
                name="category"
                className="select-fluent"
                value={category}
                onChange={(e) => setCategory(e.target.value as LaunchpadCategoryKey)}
              >
                {categoryOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="launchpad-field">
              <div className="launchpad-field-head">
                <label htmlFor={noteInputId}>
                  {t('launchpad.wizard.maker_note_label')}
                  <span className="launchpad-field-required" aria-hidden="true">*</span>
                </label>
                <span className="launchpad-note-counter" data-testid="launchpad-note-counter">
                  {noteValidation.length} / {MAKER_NOTE_MAX_LENGTH}
                </span>
              </div>
              <span id={noteHintId} className="launchpad-field-hint">
                {t('launchpad.wizard.maker_note_hint')}
              </span>
              <textarea
                ref={noteInputRef}
                id={noteInputId}
                name="maker_note"
                className="launchpad-textarea"
                rows={2}
                value={makerNote}
                onChange={(e) => setMakerNote(e.target.value)}
                onBlur={() => markTouched('makerNote')}
                placeholder={t('launchpad.wizard.maker_note_placeholder')}
                required
                aria-invalid={showNoteError ? 'true' : 'false'}
                aria-describedby={showNoteError ? `${noteHintId} ${noteErrorId}` : noteHintId}
              />
              {showNoteError && (
                <div id={noteErrorId} className="launchpad-field-error">
                  <XCircle size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span>{noteError}</span>
                </div>
              )}
            </div>

            <div className="launchpad-field">
              <label htmlFor={noteEnInputId}>{t('launchpad.wizard.maker_note_en_label')}</label>
              <input
                ref={noteEnInputRef}
                id={noteEnInputId}
                name="maker_note_en"
                type="text"
                className="launchpad-input"
                value={makerNoteEn}
                onChange={(e) => setMakerNoteEn(e.target.value)}
                onBlur={() => markTouched('makerNoteEn')}
                placeholder={t('launchpad.wizard.maker_note_en_placeholder')}
                aria-invalid={showNoteEnError ? 'true' : 'false'}
                aria-describedby={showNoteEnError ? noteEnErrorId : undefined}
              />
              {showNoteEnError && (
                <div id={noteEnErrorId} className="launchpad-field-error">
                  <XCircle size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span>{noteEnError}</span>
                </div>
              )}
            </div>

            <div className="launchpad-field">
              <label htmlFor={tierSelectId}>{t('launchpad.wizard.launch_tier_label')}</label>
              <select
                id={tierSelectId}
                name="launch_tier"
                className="select-fluent"
                value={launchTier}
                onChange={(e) => setLaunchTier(e.target.value as LaunchpadTier)}
              >
                {tierOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="launchpad-field">
              <label htmlFor={iconInputId}>{t('launchpad.wizard.custom_icon_label')}</label>
              <span id={iconHintId} className="launchpad-field-hint">
                {t('launchpad.wizard.custom_icon_hint')}
              </span>
              <input
                ref={iconInputRef}
                id={iconInputId}
                name="custom_icon_url"
                type="url"
                className="launchpad-input"
                value={customIconUrl}
                onChange={(e) => setCustomIconUrl(e.target.value)}
                onBlur={() => markTouched('customIconUrl')}
                placeholder={t('launchpad.wizard.custom_icon_placeholder')}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={showIconError ? 'true' : 'false'}
                aria-describedby={showIconError ? `${iconHintId} ${iconErrorId}` : iconHintId}
              />
              {showIconError && (
                <div id={iconErrorId} className="launchpad-field-error">
                  <XCircle size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span>{customIconError}</span>
                </div>
              )}
            </div>
          </div>

          <div className="launchpad-submit-col">
            <div className="launchpad-preflight-panel">
              <div className="launchpad-preflight-head">
                <h4>{t('launchpad.wizard.checks_title')}</h4>
                <button
                  type="button"
                  className="btn-fluent btn-secondary btn-compact"
                  data-testid="launchpad-preflight-run"
                  disabled={checking}
                  onClick={() => void handleRunPreflight()}
                >
                  {checking ? (
                    <RefreshCw size={13} strokeWidth={1.5} className="icon-spin" aria-hidden="true" />
                  ) : (
                    <SearchCheck size={13} strokeWidth={1.5} aria-hidden="true" />
                  )}
                  <span>
                    {checking
                      ? t('launchpad.wizard.running_preflight')
                      : t('launchpad.wizard.run_preflight')}
                  </span>
                </button>
              </div>

              {isStalePreflight && (
                <div className="launchpad-preflight-item is-warn" role="status">
                  <AlertTriangle size={14} strokeWidth={1.5} aria-hidden="true" />
                  <span>{t('launchpad.wizard.rerun_hint')}</span>
                </div>
              )}

              {preflightError && (
                <div className="launchpad-preflight-item is-fail" role="alert">
                  <XCircle size={14} strokeWidth={1.5} aria-hidden="true" />
                  <span>{preflightError}</span>
                </div>
              )}

              {preflight && preflight.checks.length > 0 ? (
                <ul className="launchpad-preflight-list" data-testid="launchpad-preflight-checks">
                  {preflight.checks.map((item) => (
                    <li
                      key={`${item.key}-${item.status}`}
                      className={`launchpad-preflight-item is-${item.status}`}
                    >
                      {item.status === 'pass' ? (
                        <CheckCircle2 size={14} strokeWidth={1.5} aria-label={t('launchpad.wizard.status_pass')} />
                      ) : item.status === 'warn' ? (
                        <AlertTriangle size={14} strokeWidth={1.5} aria-label={t('launchpad.wizard.status_warn')} />
                      ) : (
                        <XCircle size={14} strokeWidth={1.5} aria-label={t('launchpad.wizard.status_fail')} />
                      )}
                      <span>{item.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="launchpad-preflight-empty">{t('launchpad.wizard.checks_empty')}</p>
              )}
            </div>

            <div className="launchpad-preview-head">
              <h4>{t('launchpad.wizard.preview_title')}</h4>
              <span className="launchpad-preview-hint">{t('launchpad.wizard.preview_hint')}</span>
            </div>
            <div className="launchpad-preview-stage" data-testid="launchpad-wizard-preview">
              <LaunchpadCard
                entry={previewEntry}
                variant={launchTier === 'free' ? 'recent' : 'spotlight'}
                platformLoading={checking}
                isInstalled={false}
                isManaged={null}
                onOpen={notifyPreviewDisabled}
                onOpenDetail={notifyPreviewDisabled}
                onQuickInstall={notifyPreviewDisabled}
                onOpenMaker={notifyPreviewDisabled}
                onToggleStar={notifyPreviewDisabled}
                onUpvote={notifyPreviewDisabled}
                onOpenDiscussion={notifyPreviewDisabled}
                onOpenSource={notifyPreviewDisabled}
              />
            </div>
          </div>
        </div>

        <div className="modal-footer launchpad-submit-footer">
          <span className="launchpad-submit-footer-note">
            {preflightMatchesCurrent && !preflight?.ok ? t('launchpad.wizard.err_preflight_failed') : ''}
          </span>
          <div className="launchpad-submit-footer-actions">
            <button
              type="button"
              className="btn-fluent btn-secondary"
              onClick={onClose}
            >
              {t('launchpad.wizard.cancel')}
            </button>
            <button
              type="submit"
              className="btn-fluent btn-primary"
              data-testid="launchpad-submit-confirm"
              disabled={!canSubmit}
            >
              <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>{t('launchpad.wizard.submit_github')}</span>
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
};
