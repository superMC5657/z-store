/**
 * 待收录页草稿表单卡（新建/编辑）：顶部标题栏 + 四个表单段子组件（D 坐标 / A 核心 /
 * B 补充 / C 运行时）+ 固定页脚。各段只接收自身用到的 props 并各自声明类型，
 * 字段缺失在编译期暴露。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlignLeft,
  ChevronDown,
  ChevronRight,
  Archive,
  FileText,
  Inbox,
  Link2,
  PencilLine,
  Send,
  ShieldCheck,
  Sliders,
  Trash2,
} from 'lucide-react';
import {
  isPendingCollectedStatus,
  isSubmittedEntry,
  PENDING_OFFICIAL_CATEGORIES,
  type CustomDraftEntry,
  type PendingDraftErrors,
  type PendingDraftItem,
} from './draftModel';
import { errorStyle, hintStyle, labelStyle } from './pendingStyles';
import { errorText } from './pendingText';

interface PendingDraftFormProps {
  form: PendingDraftItem;
  /** 单字段变更（owner/repo 键入联动 id 的逻辑统筹于调用方）。 */
  onField: <K extends keyof PendingDraftItem>(key: K, value: PendingDraftItem[K]) => void;
  /** 文本态字段（aliases/platforms/identifiers）变更。 */
  onTextField: (key: 'aliases' | 'platforms' | 'identifiers', value: string) => void;
  onFieldBlur: () => void;
  formErrors: PendingDraftErrors;
  /** 文本态字段当前值（受控编辑）。 */
  aliasesText: string;
  platformsText: string;
  identifiersText: string;
  isCreating: boolean;
  isArchived: boolean;
  /** 选中行（非新建态可空）。 */
  editing: CustomDraftEntry | null;
  openSections: { supplemental: boolean; runtime: boolean };
  onToggleSection: (key: 'supplemental' | 'runtime') => void;
  onSave: () => void;
  confirmDeleteId: string | null;
  onDelete: (id: string) => void;
  collectingId: string | null;
  onCollectLocal: (id: string) => void;
  hasSubmitErrors: boolean;
  hasLicenseSubmitError: boolean;
  revertingId: string | null;
  confirmRevertId: string | null;
  onRevertToDraft: (id: string) => void;
  submittingId: string | null;
  onSubmitPr: (id: string) => void;
  prUrlInput: string;
  onPrUrlInput: (value: string) => void;
  onMarkSubmitted: (id: string) => void;
}

/** 各段只取自身用到的字段，拼错的字段名/漏传在编译期暴露。 */
type FormHeaderProps = Pick<PendingDraftFormProps, 'isCreating' | 'editing' | 'formErrors'>;
type CoordsSectionProps = Pick<
  PendingDraftFormProps,
  'form' | 'onField' | 'onFieldBlur' | 'formErrors'
>;
type CoreSectionProps = Pick<
  PendingDraftFormProps,
  'form' | 'onField' | 'onFieldBlur' | 'formErrors' | 'isArchived'
>;
type SupplementalSectionProps = Pick<
  PendingDraftFormProps,
  | 'form'
  | 'onField'
  | 'onTextField'
  | 'onFieldBlur'
  | 'aliasesText'
  | 'openSections'
  | 'onToggleSection'
  | 'isArchived'
>;
type RuntimeSectionProps = Pick<
  PendingDraftFormProps,
  | 'onTextField'
  | 'onFieldBlur'
  | 'platformsText'
  | 'identifiersText'
  | 'openSections'
  | 'onToggleSection'
  | 'isArchived'
>;
type FormFooterProps = Pick<
  PendingDraftFormProps,
  | 'isCreating'
  | 'isArchived'
  | 'editing'
  | 'confirmDeleteId'
  | 'onDelete'
  | 'collectingId'
  | 'onCollectLocal'
  | 'hasSubmitErrors'
  | 'hasLicenseSubmitError'
  | 'revertingId'
  | 'confirmRevertId'
  | 'onRevertToDraft'
  | 'submittingId'
  | 'onSubmitPr'
  | 'prUrlInput'
  | 'onPrUrlInput'
  | 'onMarkSubmitted'
  | 'onSave'
>;

export const PendingDraftForm: React.FC<PendingDraftFormProps> = (props) => {
  const { isCreating } = props;

  return (
    <div className="app-card pending-editor-card">
      <FormHeader
        isCreating={props.isCreating}
        editing={props.editing}
        formErrors={props.formErrors}
      />
      {isCreating && (
        <CoordsSection
          form={props.form}
          onField={props.onField}
          onFieldBlur={props.onFieldBlur}
          formErrors={props.formErrors}
        />
      )}
      <CoreSection
        form={props.form}
        onField={props.onField}
        onFieldBlur={props.onFieldBlur}
        formErrors={props.formErrors}
        isArchived={props.isArchived}
      />
      <SupplementalSection
        form={props.form}
        onField={props.onField}
        onTextField={props.onTextField}
        onFieldBlur={props.onFieldBlur}
        aliasesText={props.aliasesText}
        openSections={props.openSections}
        onToggleSection={props.onToggleSection}
        isArchived={props.isArchived}
      />
      <RuntimeSection
        onTextField={props.onTextField}
        onFieldBlur={props.onFieldBlur}
        platformsText={props.platformsText}
        identifiersText={props.identifiersText}
        openSections={props.openSections}
        onToggleSection={props.onToggleSection}
        isArchived={props.isArchived}
      />
      <FormFooter
        isCreating={props.isCreating}
        isArchived={props.isArchived}
        editing={props.editing}
        confirmDeleteId={props.confirmDeleteId}
        onDelete={props.onDelete}
        collectingId={props.collectingId}
        onCollectLocal={props.onCollectLocal}
        hasSubmitErrors={props.hasSubmitErrors}
        hasLicenseSubmitError={props.hasLicenseSubmitError}
        revertingId={props.revertingId}
        confirmRevertId={props.confirmRevertId}
        onRevertToDraft={props.onRevertToDraft}
        submittingId={props.submittingId}
        onSubmitPr={props.onSubmitPr}
        prUrlInput={props.prUrlInput}
        onPrUrlInput={props.onPrUrlInput}
        onMarkSubmitted={props.onMarkSubmitted}
        onSave={props.onSave}
      />
    </div>
  );
};

/** 顶部标题栏：新建/编辑标题 + 分组徽标（编辑态下提供坐标/ID 校验错误兜底槽位）。 */
function FormHeader({ isCreating, editing, formErrors }: FormHeaderProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="pending-editor-header">
        <div className="pending-editor-title-wrap">
          <PencilLine size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <strong
            className="pending-editor-title"
            title={isCreating ? undefined : editing?.id}
          >
            {isCreating ? t('pending.new_draft') : editing?.id}
          </strong>
          {editing?.archived && (
            <span className="nav-badge" title={t('pending.archived_badge')}>
              {t('pending.archived_badge')}
            </span>
          )}
          {!isCreating && editing && isSubmittedEntry(editing) && (
            <span className="nav-badge" style={{ color: 'var(--brand-primary)', borderColor: 'var(--brand-glow)' }}>
              {t('pending.segments.submitted')}
            </span>
          )}
          {!isCreating && editing && !editing.archived && isPendingCollectedStatus(editing.status) && editing.status !== 'submitted' && (
            <span className="nav-badge" title={t('pending.groups.library')}>
              {t('pending.groups.library')}
            </span>
          )}
        </div>
      </div>
      {!isCreating && (formErrors.owner || formErrors.repo || formErrors.id) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
          {formErrors.owner && (
            <em data-testid="pending-error-owner" style={errorStyle}>
              {errorText(t, formErrors.owner)}
            </em>
          )}
          {formErrors.repo && (
            <em data-testid="pending-error-repo" style={errorStyle}>
              {errorText(t, formErrors.repo)}
            </em>
          )}
          {formErrors.id && (
            <em data-testid="pending-error-id" style={errorStyle}>
              {errorText(t, formErrors.id)}
            </em>
          )}
        </div>
      )}
    </>
  );
}

/** 分节 D：仓库坐标（仅新建态展示 owner/repo 输入，id 由系统按小写 owner/repo 自动生成）。 */
function CoordsSection({
  form, onField, onFieldBlur, formErrors,
}: CoordsSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="pending-section-header pending-section-header-static">
        <div className="pending-section-title-wrap">
          <ShieldCheck size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('pending.sections.coords')}</span>
        </div>
      </div>

      <label style={labelStyle}>
        <span>{t('pending.fields.owner')}</span>
        <input
          className="input-fluent input-mono"
          value={form.owner}
          onChange={(e) => onField('owner', e.target.value)}
          onBlur={onFieldBlur}
          placeholder="rustdesk"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={Boolean(formErrors.owner) || undefined}
        />
        {formErrors.owner && (
          <em data-testid="pending-error-owner" style={errorStyle}>
            {errorText(t, formErrors.owner)}
          </em>
        )}
      </label>

      <label style={labelStyle}>
        <span>{t('pending.fields.repo')}</span>
        <input
          className="input-fluent input-mono"
          value={form.repo}
          onChange={(e) => onField('repo', e.target.value)}
          onBlur={onFieldBlur}
          placeholder="rustdesk"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={Boolean(formErrors.repo) || undefined}
        />
        {formErrors.repo && (
          <em data-testid="pending-error-repo" style={errorStyle}>
            {errorText(t, formErrors.repo)}
          </em>
        )}
        {formErrors.id && (
          <em data-testid="pending-error-id" style={errorStyle}>
            {errorText(t, formErrors.id)}
          </em>
        )}
      </label>
    </>
  );
}

/** 分节 A：核心信息（核心必填，恒定展开，不可隐藏）。 */
function CoreSection({
  form, onField, onFieldBlur, formErrors, isArchived,
}: CoreSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="pending-section-header pending-section-header-static">
        <div className="pending-section-title-wrap">
          <FileText size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('pending.sections.core')}</span>
          <span className="pending-section-count">6</span>
        </div>
      </div>

      <label style={labelStyle}>
        <span>{t('pending.fields.name')}</span>
        <input
          className="input-fluent"
          value={form.name}
          onChange={(e) => onField('name', e.target.value)}
          onBlur={onFieldBlur}
          placeholder={t('pending.placeholders.name')}
          aria-invalid={Boolean(formErrors.name) || undefined}
          readOnly={isArchived}
        />
        {formErrors.name && (
          <em data-testid="pending-error-name" style={errorStyle}>
            {errorText(t, formErrors.name)}
          </em>
        )}
      </label>

      <label style={labelStyle}>
        <span>{t('pending.fields.description')}</span>
        <textarea
          className="input-fluent"
          value={form.description}
          onChange={(e) => onField('description', e.target.value)}
          onBlur={onFieldBlur}
          rows={2}
          placeholder={t('pending.placeholders.description')}
          aria-invalid={Boolean(formErrors.description) || undefined}
          readOnly={isArchived}
        />
        {formErrors.description && (
          <em data-testid="pending-error-description" style={errorStyle}>
            {errorText(t, formErrors.description)}
          </em>
        )}
      </label>

      <label style={labelStyle}>
        <span>{t('pending.fields.category')}</span>
        <select
          className="select-fluent"
          data-testid="pending-select-category"
          value={form.category}
          onChange={(e) => onField('category', e.target.value)}
          onBlur={onFieldBlur}
          aria-invalid={Boolean(formErrors.category) || undefined}
          disabled={isArchived}
        >
          {!PENDING_OFFICIAL_CATEGORIES.includes(
            form.category as (typeof PENDING_OFFICIAL_CATEGORIES)[number],
          ) && (
            <option value={form.category} disabled>
              {form.category || t('pending.placeholders.category')}
            </option>
          )}
          {PENDING_OFFICIAL_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {t(`categories.cat_${cat}_name`)}
            </option>
          ))}
        </select>
        {formErrors.category && (
          <em data-testid="pending-error-category" style={errorStyle}>
            {errorText(t, formErrors.category)}
          </em>
        )}
      </label>

      <label style={labelStyle}>
        <span>{t('pending.fields.license')}</span>
        <input
          className="input-fluent input-mono"
          value={form.license}
          onChange={(e) => onField('license', e.target.value)}
          onBlur={onFieldBlur}
          placeholder="MIT"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={Boolean(formErrors.license) || undefined}
          readOnly={isArchived}
        />
        {formErrors.license && (
          <em data-testid="pending-error-license" style={errorStyle}>
            {errorText(t, formErrors.license)}
          </em>
        )}
      </label>

      <label style={labelStyle}>
        <span>{t('pending.fields.homepage')}</span>
        <input
          className="input-fluent"
          value={form.homepage}
          onChange={(e) => onField('homepage', e.target.value)}
          onBlur={onFieldBlur}
          placeholder="https://example.com"
          inputMode="url"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={Boolean(formErrors.homepage) || undefined}
          readOnly={isArchived}
        />
        {formErrors.homepage && (
          <em data-testid="pending-error-homepage" style={errorStyle}>
            {errorText(t, formErrors.homepage)}
          </em>
        )}
      </label>

      <label style={labelStyle}>
        <span>{t('pending.fields.default_version')}</span>
        <input
          className="input-fluent input-mono"
          value={form.default_version}
          onChange={(e) => onField('default_version', e.target.value)}
          onBlur={onFieldBlur}
          placeholder="v0.1.0"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={isArchived}
        />
      </label>
    </>
  );
}

/** 分节 B：补充信息（可选补充，默认展开，允许折叠）。 */
function SupplementalSection({
  form, onField, onTextField, onFieldBlur, aliasesText, openSections, onToggleSection, isArchived,
}: SupplementalSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={openSections.supplemental}
        className="pending-section-header"
        onClick={() => onToggleSection('supplemental')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleSection('supplemental');
          }
        }}
      >
        <div className="pending-section-title-wrap">
          <AlignLeft size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('pending.sections.supplemental')}</span>
          <span className="pending-section-count">4</span>
        </div>
        {openSections.supplemental ? (
          <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
        )}
      </div>

      <label style={{ ...labelStyle, display: openSections.supplemental ? 'flex' : 'none' }}>
        <span>{t('pending.fields.category_name')}</span>
        <input
          className="input-fluent"
          value={form.category_name}
          onChange={(e) => onField('category_name', e.target.value)}
          onBlur={onFieldBlur}
          placeholder={t('pending.placeholders.category_name')}
          readOnly={isArchived}
        />
      </label>

      <label style={{ ...labelStyle, display: openSections.supplemental ? 'flex' : 'none' }}>
        <span>{t('pending.fields.description_en')}</span>
        <textarea
          className="input-fluent"
          value={form.description_en}
          onChange={(e) => onField('description_en', e.target.value)}
          onBlur={onFieldBlur}
          rows={2}
          placeholder={t('pending.placeholders.description_en')}
          readOnly={isArchived}
        />
      </label>

      <label style={{ ...labelStyle, display: openSections.supplemental ? 'flex' : 'none' }}>
        <span>{t('pending.fields.icon')}</span>
        <input
          className="input-fluent"
          value={form.icon}
          onChange={(e) => onField('icon', e.target.value)}
          onBlur={onFieldBlur}
          placeholder="https://…"
          inputMode="url"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={isArchived}
        />
      </label>

      <label style={{ ...labelStyle, display: openSections.supplemental ? 'flex' : 'none' }}>
        <span>{t('pending.fields.aliases')}</span>
        <input
          className="input-fluent"
          value={aliasesText}
          onChange={(e) => onTextField('aliases', e.target.value)}
          onBlur={onFieldBlur}
          placeholder={t('pending.placeholders.csv')}
          readOnly={isArchived}
        />
      </label>
    </>
  );
}

/** 分节 C：高级运行时（默认折叠，允许展开）。 */
function RuntimeSection({
  onTextField, onFieldBlur, platformsText, identifiersText, openSections, onToggleSection, isArchived,
}: RuntimeSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={openSections.runtime}
        className="pending-section-header"
        onClick={() => onToggleSection('runtime')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleSection('runtime');
          }
        }}
      >
        <div className="pending-section-title-wrap">
          <Sliders size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('pending.sections.runtime')}</span>
          <span className="pending-section-count">2</span>
        </div>
        {openSections.runtime ? (
          <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
        )}
      </div>

      <label style={{ ...labelStyle, display: openSections.runtime ? 'flex' : 'none' }}>
        <span>{t('pending.fields.platforms')}</span>
        <input
          className="input-fluent input-mono"
          value={platformsText}
          onChange={(e) => onTextField('platforms', e.target.value)}
          onBlur={onFieldBlur}
          placeholder="windows, linux"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={isArchived}
        />
      </label>

      <label style={{ ...labelStyle, display: openSections.runtime ? 'flex' : 'none' }}>
        <span>{t('pending.fields.identifiers')}</span>
        <textarea
          className="input-fluent input-mono"
          value={identifiersText}
          onChange={(e) => onTextField('identifiers', e.target.value)}
          onBlur={onFieldBlur}
          rows={2}
          placeholder="windows=rustdesk.exe"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={isArchived}
        />
        <span style={hintStyle}>{t('pending.identifiers_hint')}</span>
      </label>
    </>
  );
}

/** 固定卡片底部 Footer：保存/删除/收录/提交 Issue/退回/手动标记行。 */
function FormFooter({
  isCreating, isArchived, editing, confirmDeleteId, onDelete, collectingId,
  onCollectLocal, hasSubmitErrors, hasLicenseSubmitError, revertingId,
  confirmRevertId, onRevertToDraft, submittingId, onSubmitPr, prUrlInput,
  onPrUrlInput, onMarkSubmitted, onSave,
}: FormFooterProps) {
  const { t } = useTranslation();
  return (
    <div className="pending-editor-footer">
      <div className="pending-editor-footer-actions">
        <button
          type="button"
          className={`btn-fluent ${isCreating ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          onClick={onSave}
          disabled={isArchived}
          title={isArchived ? t('pending.archived_save_disabled') : undefined}
        >
          {t('pending.save')}
        </button>
        {!isCreating && editing && !isArchived && (
          <button
            type="button"
            className="btn-fluent btn-secondary btn-sm"
            onClick={() => onDelete(editing.id)}
            title={t('pending.delete_hint')}
          >
            <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>
              {confirmDeleteId === editing.id ? t('pending.confirm_delete') : t('pending.delete')}
            </span>
          </button>
        )}
        {isArchived && (
          <span className="pending-archived-hint">
            {t('pending.archived_readonly_hint')}
          </span>
        )}
        {!isCreating && editing && !isArchived && editing.status === 'draft' && (
          <button
            type="button"
            className="btn-fluent btn-primary btn-sm"
            data-testid="pending-collect-local"
            disabled={collectingId === editing.id}
            onClick={() => void onCollectLocal(editing.id)}
            title={
              hasSubmitErrors
                ? hasLicenseSubmitError
                  ? t('pending.pr.license_fix_hint', { id: editing.id })
                  : t('pending.fix_errors')
                : t('pending.need_local_hint', { id: editing.id })
            }
            style={{ marginLeft: 'auto' }}
          >
            <Inbox size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>
              {collectingId === editing.id
                ? t('pending.collecting')
                : t('pending.collect_local')}
            </span>
          </button>
        )}
        {!isCreating && editing && !isArchived && isPendingCollectedStatus(editing.status) && (
          <>
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              data-testid="pending-revert-to-draft"
              disabled={revertingId === editing.id}
              onClick={() => void onRevertToDraft(editing.id)}
              title={t('pending.revert_hint', { id: editing.id })}
              style={{ marginLeft: 'auto' }}
            >
              <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {confirmRevertId === editing.id
                  ? t('pending.confirm_revert')
                  : t('pending.revert_to_draft')}
              </span>
            </button>
            <button
              type="button"
              className="btn-fluent btn-primary btn-sm"
              data-testid="pending-submit-pr"
              disabled={submittingId === editing.id}
              onClick={() => void onSubmitPr(editing.id)}
              title={
                hasSubmitErrors
                  ? hasLicenseSubmitError
                    ? t('pending.pr.license_fix_hint', { id: editing.id })
                    : t('pending.fix_errors')
                  : t('pending.pr.prefill_hint')
              }
            >
              <Send size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {submittingId === editing.id
                  ? t('pending.pr.submitting')
                  : t('pending.pr.submit_pr')}
              </span>
            </button>
          </>
        )}
      </div>

      {!isCreating && editing && !isArchived && isPendingCollectedStatus(editing.status) && (
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
              onClick={() => onMarkSubmitted(editing.id)}
            >
              <Send size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>{t('pending.mark_submitted')}</span>
            </button>
          </div>
          {editing.pr_url && (
            <div className="pending-editor-pr-link">
              <Link2 size={12} strokeWidth={1.5} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
              <a
                href={editing.pr_url}
                target="_blank"
                rel="noreferrer"
                title={t('pending.pr.open_pr')}
                aria-label={t('pending.pr.open_pr')}
              >
                {editing.pr_url}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
