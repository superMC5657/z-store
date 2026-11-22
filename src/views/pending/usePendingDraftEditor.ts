/** 待收录草稿表单编辑器：字段与文本态缓冲（别名 CSV / 平台 CSV / 多平台标识符）、归一与双档校验。 */
import { useCallback, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import type { DraftItem } from '../../services/custom';
import type { LicenseAllowlistResult } from '../../services/api/catalog';
import { scrollBehavior } from '../../lib/motion';
import {
  PENDING_EMPTY_DRAFT,
  canonicalDraftId,
  parseIdentifiersText,
  splitCsv,
  stringifyIdentifiers,
  validatePendingDraft,
  type LicenseAllowlistInput,
  type PendingDraftErrors,
} from './draftModel';

export type PendingTextField = 'aliases' | 'platforms' | 'identifiers';

interface TextBuffers {
  aliases: string;
  platforms: string;
  identifiers: string;
}

/** 归一草稿表单与文本态字段（id 由非空 owner/repo 自动按小写派生，否则保留已有 id）。 */
function normalizeFormItem(f: DraftItem, text: TextBuffers): DraftItem {
  const owner = f.owner.trim();
  const repo = f.repo.trim();
  const id = owner && repo ? canonicalDraftId(owner, repo) : f.id.trim();
  const category = f.category.trim();
  return {
    ...f,
    id,
    name: f.name.trim(),
    owner,
    repo,
    description: f.description.trim(),
    description_en: f.description_en.trim(),
    category,
    category_name: f.category_name.trim() || category,
    license: f.license.trim(),
    homepage: f.homepage.trim(),
    icon: f.icon.trim(),
    icon_bg: f.icon_bg.trim(),
    default_version: f.default_version.trim() || 'v0.1.0',
    aliases: splitCsv(text.aliases),
    platforms: splitCsv(text.platforms.toLowerCase()),
    // 草稿即 catalog.json 单个应用 JSON：模板无 publishers/install_dirs/search_subdirs 时不出现，恒 []。
    publishers: [],
    install_dirs: [],
    search_subdirs: [],
    identifiers: parseIdentifiersText(text.identifiers),
  };
}

/** 首错定位顺序（与表单字段顺序一致）。 */
const ERROR_FOCUS_ORDER: Array<keyof PendingDraftErrors> = [
  'owner',
  'repo',
  'id',
  'name',
  'description',
  'category',
  'license',
  'homepage',
];

/** 滚动到首个错误的内联槽位并聚焦其输入框。 */
function focusFirstError(errors: PendingDraftErrors): void {
  const first = ERROR_FOCUS_ORDER.find((k) => errors[k]);
  if (!first) return;
  window.setTimeout(() => {
    const el = document.querySelector(`[data-testid="pending-error-${first}"]`);
    if (!el) return;
    try {
      (el as HTMLElement).scrollIntoView?.({ behavior: scrollBehavior(), block: 'center' });
    } catch {
      /* jsdom 无滚动实现时忽略 */
    }
    const box = (el as HTMLElement).closest('label, div');
    const input = box?.querySelector('input, textarea') as HTMLElement | null;
    try {
      input?.focus?.();
    } catch {
      /* 忽略 */
    }
  }, 0);
}

/**
 * @param licenseGate 已预取的许可名单快照；未就绪时逐框校验按门禁关闭处理（不标 osi/gate，仍保留 required）。
 */
export function usePendingDraftEditor(t: TFunction, licenseGate: LicenseAllowlistResult | null) {
  const [form, setForm] = useState<DraftItem>(PENDING_EMPTY_DRAFT);
  const [text, setText] = useState<TextBuffers>({ aliases: '', platforms: 'windows', identifiers: '' });
  const [formErrors, setFormErrors] = useState<PendingDraftErrors>({});

  const effectiveGate: LicenseAllowlistInput = useMemo(
    () => licenseGate ?? { enabled: false, allowed: [] },
    [licenseGate],
  );

  const normalized = useMemo(() => normalizeFormItem(form, text), [form, text]);
  const liveSubmitErrors = useMemo(
    () => validatePendingDraft(normalized, 'submit', effectiveGate),
    [normalized, effectiveGate],
  );

  const loadIntoForm = useCallback((item: DraftItem) => {
    setForm({ ...item });
    setText({
      aliases: item.aliases.join(', '),
      platforms: item.platforms.join(', '),
      identifiers: stringifyIdentifiers(item.identifiers),
    });
    setFormErrors({});
  }, []);

  const setField = <K extends keyof DraftItem>(key: K, value: DraftItem[K]) => {
    const next = { ...form, [key]: value };
    if (key === 'owner' || key === 'repo') {
      const owner = key === 'owner' ? String(value) : form.owner;
      const repo = key === 'repo' ? String(value) : form.repo;
      next.id = owner.trim() && repo.trim() ? canonicalDraftId(owner, repo) : '';
    }
    if (key === 'category') {
      const cat = String(value);
      if (cat) next.category_name = t(`categories.cat_${cat}_name`, { defaultValue: cat });
    }
    setForm(next);
    // 逐框即时校验：对归一后表单跑 submit 档（license 用快照，不每键 IPC）。
    setFormErrors(validatePendingDraft(normalizeFormItem(next, text), 'submit', effectiveGate));
  };

  const setTextField = (key: PendingTextField, value: string) => {
    const next = { ...text, [key]: value };
    setText(next);
    setFormErrors(validatePendingDraft(normalizeFormItem(form, next), 'submit', effectiveGate));
  };

  const onFieldBlur = () => {
    setFormErrors(validatePendingDraft(normalized, 'submit', effectiveGate));
  };

  /** 暂存档（DraftLenient）：仅校验身份，结果写入内联错误。 */
  const validateForSave = (): { item: DraftItem; ok: boolean } => {
    const errors = validatePendingDraft(normalized, 'draft');
    setFormErrors(errors);
    return { item: normalized, ok: Object.keys(errors).length === 0 };
  };

  /** 提交档（真实门禁）：错即内联 + 定位首错。 */
  const validateForSubmit = (gate: LicenseAllowlistInput): { item: DraftItem; ok: boolean } => {
    const errors = validatePendingDraft(normalized, 'submit', gate);
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      focusFirstError(errors);
      return { item: normalized, ok: false };
    }
    return { item: normalized, ok: true };
  };

  const clearErrors = useCallback(() => setFormErrors({}), []);

  const previewPlatforms = useMemo(() => splitCsv(text.platforms.toLowerCase()), [text.platforms]);
  const expectedId = form.owner.trim() && form.repo.trim() ? canonicalDraftId(form.owner, form.repo) : '';

  return {
    form,
    aliasesText: text.aliases,
    platformsText: text.platforms,
    identifiersText: text.identifiers,
    formErrors,
    liveSubmitErrors,
    hasSubmitErrors: Object.keys(liveSubmitErrors).length > 0,
    hasLicenseSubmitError: Boolean(liveSubmitErrors.license),
    previewPlatforms,
    expectedId,
    loadIntoForm,
    setField,
    setTextField,
    onFieldBlur,
    validateForSave,
    validateForSubmit,
    clearErrors,
  };
}
