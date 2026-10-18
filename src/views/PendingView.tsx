import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-pending.css';
import {
  AlignLeft,
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Globe,
  Inbox,
  Link2,
  PencilLine,
  Plus,
  Send,
  ShieldCheck,
  Sliders,
  Tag,
  Trash2,
} from 'lucide-react';
import { FilterEmptyState, ViewShell } from './ViewShell';
import { PlatformIcon } from '../components/icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../lib/platformFilter';
import {
  buildBatchPrPayloadJson,
  buildLocalBatchPrUrl,
  buildLocalSinglePrUrl,
  buildSinglePrPayloadJson,
  copyTextToClipboard,
  getLicenseAllowlist,
  type LicenseAllowlistResult,
} from '../services/api/catalog';

export type { LicenseAllowlistResult };

/**
 * Lane B 待收录页（UI 层，ADR-0017 草稿 overlay 前端）。
 *
 * - 后端已落盘（Lane A）：custom_apps 表 + catalog_custom commands + 合并视图；
 *   CMD 接线由 Lane C 负责，本文件只管 UI，不直调任何 Tauri 命令
 *  （许可名单经 `services/api/catalog.getLicenseAllowlist` 封装调用，
 *   无字面量命令名直调，见 noDirectInvoke.test.ts）。
 * - 许可名单唯一源头为后端（ADR-0018 `get_license_allowlist` 只读命令）：
 *   本文件不保留任何硬编码名单；暂存走 draft 档（不查名单），
 *   提交/预填 PR 前拉取后端名单做 submit 档校验；加载失败放行暂存、
 *   提交提示重试。
 * - 受控/非受控双模：传入 `entries` 即为受控（Lane C 接线后直接透传后端列表），
 *   缺席时走内部本地态（浏览器预览/单测可独立渲染编辑）。
 * - 设计走 Linear 去彩单色：仅用文本层级 + 边框 + 单色图标，不引入彩色语义。
 */

/** 草稿 payload（CatalogItem 可编辑子集，is_verified 恒 false，不参与表单）。 */
export interface PendingDraftItem {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  description_en: string;
  category: string;
  category_name: string;
  aliases: string[];
  default_version: string;
  license: string;
  homepage: string;
  identifiers: Record<string, string[]>;
  install_dirs: string[];
  search_subdirs: string[];
  publishers: string[];
  platforms: string[];
}

export type PendingDraftStatus = 'draft' | 'submitted';

/** 与后端 CustomAppEntry 同形的展示态（Lane C 透传时直接复用）。 */
export interface CustomDraftEntry {
  id: string;
  item: PendingDraftItem;
  status: PendingDraftStatus;
  pr_url?: string | null;
  archived: boolean;
  updated_at?: number;
}

export type PendingGroupId = 'draft' | 'submitted' | 'archived';

export interface PendingViewProps {
  /** 受控草稿列表（Lane C 接线后传入；缺席时走内部本地态）。 */
  entries?: CustomDraftEntry[];
  /** 初始草稿（非受控模式种子，故事/单测用）。 */
  initialEntries?: CustomDraftEntry[];
  /** 保存回调（缺席时仅更新本地态，Lane C 接入后透传后端 save）。 */
  onSave?: (item: PendingDraftItem) => void | Promise<void>;
  /** 删除回调（二次确认由本组件完成，后端直接删）。 */
  onDelete?: (id: string) => void | Promise<void>;
  /** 标记已提交回调（缺席时仅翻本地态）。 */
  onMarkSubmitted?: (id: string, prUrl: string) => void | Promise<void>;
  /**
   * 单条预填 URL 提供方（Lane D 一键 PR 链路，App 透传 tauriApi.getCustomAppPrUrl；
   * 缺席时用本地同形兜底，浏览器预览/单测可用）。
   */
  onGetPrUrl?: (id: string) => Promise<string>;
  /**
   * 批量预填 URL 提供方（Lane D 二期开关，App 透传 tauriApi.getCustomAppsBatchPrUrl；
   * 缺席时用本地同形兜底）。
   */
  onGetBatchPrUrl?: (ids: string[]) => Promise<string>;
  /**
   * 许可名单提供方（ADR-0018 唯一源头只读命令的前端封装；
   * 缺席时默认走 `getLicenseAllowlist`，单测可注入桩）。
   * 启动/提交前拉取，失败不回退写死名单（暂存放行、提交提示重试）。
   */
  onGetLicenseAllowlist?: () => Promise<LicenseAllowlistResult>;
  /** 二期批量栏开关（默认开启，传 false 隐藏）。 */
  showBatchBar?: boolean;
  /** 轻提示通道（Lane C 可接入 Toast；缺席时静默）。 */
  onNotify?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

export const PENDING_SHOW_COORDS_STORAGE_KEY = 'zstore:pending_show_coords';

export function getPendingShowCoordsPref(): boolean {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const val = window.localStorage.getItem(PENDING_SHOW_COORDS_STORAGE_KEY);
      if (val !== null) {
        return val === 'true';
      }
    }
  } catch {}
  return true; // 默认显示
}

export function setPendingShowCoordsPref(show: boolean): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(PENDING_SHOW_COORDS_STORAGE_KEY, String(show));
      window.dispatchEvent(new CustomEvent('zstore:pending-show-coords-changed', { detail: { show } }));
    }
  } catch {}
}

export const PENDING_EMPTY_DRAFT: PendingDraftItem = {
  id: '',
  name: '',
  owner: '',
  repo: '',
  icon: '',
  icon_bg: '',
  description: '',
  description_en: '',
  category: 'dev',
  category_name: '',
  aliases: [],
  default_version: 'v0.1.0',
  license: 'MIT',
  homepage: '',
  identifiers: {},
  install_dirs: [],
  search_subdirs: [],
  publishers: [],
  platforms: ['windows'],
};

/**
 * 协议归一（与后端 `normalize_license` 同口径）：去空白 → 大写 →
 * 空格/下划线折 `-` → 尾 `+` 视为或后续版本。
 */
export function normalizeLicense(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/[ _]+/g, '-');
  if (s.endsWith('+')) {
    s = s.slice(0, -1);
    if (!s.endsWith('-OR-LATER')) s += '-OR-LATER';
  }
  return s;
}

/**
 * 后端许可名单输入（ADR-0018 唯一源头，经 `get_license_allowlist` 拉取）：
 * 完整快照、纯名单数组（视为门禁开）、`Set` 均可；`null/undefined` 表示
 * 名单未加载——调用方不得回退写死名单（提交提示重试，暂存直接放行）。
 */
export type LicenseAllowlistInput =
  | LicenseAllowlistResult
  | readonly string[]
  | Set<string>
  | null
  | undefined;

/**
 * 名单命中判定（SubmitStrict license 口径）：两侧均经 `normalizeLicense`
 * 归一后比对，大小写/空格形态同样命中。名单缺席一律不命中（fail-closed，
 * 调用方在提交前先保证已加载，加载失败走重试提示）。
 */
export function isOsiApprovedLicense(license: string, allowlist: LicenseAllowlistInput): boolean {
  const norm = normalizeLicense(license);
  if (!norm) return false;
  if (allowlist === null || allowlist === undefined) return false;
  const entries: Iterable<string> = Array.isArray(allowlist) || allowlist instanceof Set
    ? allowlist
    : (allowlist as LicenseAllowlistResult).allowed;
  for (const candidate of entries) {
    if (typeof candidate === 'string' && normalizeLicense(candidate) === norm) return true;
  }
  return false;
}

/** 由 owner/repo 推导 canonical id（小写 owner/repo）。 */
export function canonicalDraftId(owner: string, repo: string): string {
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

export type PendingDraftErrors = Partial<Record<'id' | 'name' | 'owner' | 'repo' | 'description' | 'category' | 'homepage' | 'license', string>>;

/**
 * 草稿校验档位（与后端 `ValidateMode` 同语义）：
 * - `draft`：暂存档，仅校验身份（`id==canonical` 且与 `owner/repo` 对齐）；
 *   `license` 占位/空 `homepage`/不完整字段均放行，不触许可名单；
 * - `submit`：提交档，全量校验（必填 + `homepage` http(s) + 许可名单 D1），
 *   名单取后端 `get_license_allowlist` 快照。
 */
export type PendingValidateMode = 'draft' | 'submit';

/**
 * 草稿全字段校验（与后端 `validate_custom_item` 同口径的 UI 镜像）：
 * 暂存松（身份即可）、提交严（另查必填/homepage/license 名单）。
 * 提交档缺名单时报 `license_gate_unavailable`（fail-closed，不回退写死名单；
 * 组件侧加载失败直接提示重试，不会走到此处）。
 */
export function validatePendingDraft(
  item: PendingDraftItem,
  mode: PendingValidateMode = 'submit',
  gate?: LicenseAllowlistInput,
): PendingDraftErrors {
  const errors: PendingDraftErrors = {};
  if (!item.owner.trim() || !item.repo.trim()) {
    if (!item.owner.trim()) errors.owner = 'owner_required';
    if (!item.repo.trim()) errors.repo = 'repo_required';
  } else {
    const expected = canonicalDraftId(item.owner, item.repo);
    const actual = item.id.trim();
    if (!actual) {
      errors.id = 'id_required';
    } else if (actual !== expected || actual !== actual.toLowerCase()) {
      errors.id = 'id_mismatch';
    }
    if (item.owner.includes('/') || item.repo.includes('/')) {
      errors.owner = errors.owner ?? 'coord_slash';
    }
  }
  if (mode === 'draft') return errors;
  if (!item.name.trim()) errors.name = 'name_required';
  if (!item.description.trim()) errors.description = 'description_required';
  if (!item.category.trim()) errors.category = 'category_required';
  const homepage = item.homepage.trim();
  if (!homepage) {
    errors.homepage = 'homepage_required';
  } else if (!homepage.startsWith('http://') && !homepage.startsWith('https://')) {
    errors.homepage = 'homepage_scheme';
  }
  const license = item.license.trim();
  if (!license) {
    errors.license = 'license_required';
  } else if (gate === undefined || gate === null) {
    errors.license = 'license_gate_unavailable';
  } else {
    const enabled =
      Array.isArray(gate) || gate instanceof Set
        ? true
        : (gate as LicenseAllowlistResult).enabled !== false;
    if (enabled && !isOsiApprovedLicense(license, gate)) {
      errors.license = 'license_osi';
    }
  }
  return errors;
}

function splitLines(v: string): string[] {
  return v.split('\n').map((s) => s.trim()).filter(Boolean);
}

function splitCsv(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** identifiers 文本形态：每行 `platform=exe1, exe2`。 */
function parseIdentifiersText(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    out[key] = splitCsv(t.slice(eq + 1));
  }
  return out;
}

function stringifyIdentifiers(ids: Record<string, string[]>): string {
  return Object.entries(ids).map(([k, v]) => `${k}=${v.join(', ')}`).join('\n');
}

function entryGroup(e: CustomDraftEntry): PendingGroupId {
  if (e.archived) return 'archived';
  return e.status === 'submitted' ? 'submitted' : 'draft';
}

const GROUP_META: ReadonlyArray<{ id: PendingGroupId; icon: typeof Inbox }> = [
  { id: 'draft', icon: FilePlus2 },
  { id: 'submitted', icon: Send },
  { id: 'archived', icon: Archive },
];

export const PendingView: React.FC<PendingViewProps> = ({
  entries: controlledEntries,
  initialEntries = [],
  onSave,
  onDelete,
  onMarkSubmitted,
  onGetPrUrl,
  onGetBatchPrUrl,
  onGetLicenseAllowlist,
  showBatchBar = true,
  onNotify,
}) => {
  const { t } = useTranslation();
  const [localEntries, setLocalEntries] = useState<CustomDraftEntry[]>(initialEntries);
  const entries = controlledEntries ?? localEntries;
  const [activeGroup, setActiveGroup] = useState<PendingGroupId>('draft');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [prUrlInput, setPrUrlInput] = useState('');
  const [formErrors, setFormErrors] = useState<PendingDraftErrors>({});
  // Lane D 一键 PR 链路态：单卡提交中 id + 批量选中/提交中/栏显隐与折叠展开。
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchHidden, setBatchHidden] = useState(false);
  const [batchExpanded, setBatchExpanded] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(true);

  // 仓库坐标与标识只读区显隐（localStorage 持久化，默认开启；设置页与页头开关联动）
  const [showCoords, setShowCoords] = useState<boolean>(() => getPendingShowCoordsPref());

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ show: boolean }>;
      if (typeof custom?.detail?.show === 'boolean') {
        setShowCoords(custom.detail.show);
      } else {
        setShowCoords(getPendingShowCoordsPref());
      }
    };
    window.addEventListener('zstore:pending-show-coords-changed', handler);
    return () => {
      window.removeEventListener('zstore:pending-show-coords-changed', handler);
    };
  }, []);

  const toggleShowCoords = () => {
    const next = !showCoords;
    setShowCoords(next);
    setPendingShowCoordsPref(next);
  };

  // 表单 B/C 分节的展开/收起偏好（localStorage 持久化，A 核心必填不许折叠隐藏）
  const [openSections, setOpenSections] = useState<{ optional: boolean; runtime: boolean }>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem('zstore:pending_section_prefs');
        if (raw) {
          const parsed = JSON.parse(raw);
          return {
            optional: typeof parsed.optional === 'boolean' ? parsed.optional : true,
            runtime: typeof parsed.runtime === 'boolean' ? parsed.runtime : false,
          };
        }
      }
    } catch {}
    return { optional: true, runtime: false };
  });

  const toggleSection = (key: 'optional' | 'runtime') => {
    setOpenSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem('zstore:pending_section_prefs', JSON.stringify(next));
        }
      } catch {}
      return next;
    });
  };

  // ADR-0018 许可名单（唯一源头为后端只读命令）：启动预取 + 提交前兜底拉取。
  // 加载失败不回退任何本地名单：暂存（draft 档）本就不查名单直接放行；
  // 提交/预填前拿不到名单则提示重试并中止。
  const licenseGateRequestRef = useRef<Promise<LicenseAllowlistResult | null> | null>(null);
  const loadLicenseGate = useCallback((): Promise<LicenseAllowlistResult | null> => {
    if (licenseGateRequestRef.current) return licenseGateRequestRef.current;
    const provider = onGetLicenseAllowlist ?? getLicenseAllowlist;
    const request = (async (): Promise<LicenseAllowlistResult | null> => {
      try {
        const raw = await provider();
        const allowed = Array.isArray(raw?.allowed)
          ? raw.allowed.filter((s): s is string => typeof s === 'string')
          : [];
        // 门禁开 + 空名单视为无效快照（等价加载失败，不拿空名单误拦提交；下次可重试）。
        if (raw?.enabled !== false && allowed.length === 0) {
          licenseGateRequestRef.current = null;
          return null;
        }
        return { enabled: raw?.enabled !== false, allowed };
      } catch {
        // 加载失败：允许下次提交时重试。
        licenseGateRequestRef.current = null;
        return null;
      }
    })();
    licenseGateRequestRef.current = request;
    return request;
  }, [onGetLicenseAllowlist]);

  // 启动预取（提交时大概率已就绪；失败静默，提交时再提示重试）。
  useEffect(() => {
    void loadLicenseGate();
  }, [loadLicenseGate]);

  // 提交/预填前确保名单就绪：拿不到则提示重试并返回 null（调用方中止，不开页不标记）。
  const ensureLicenseGate = useCallback(async (): Promise<LicenseAllowlistResult | null> => {
    const gate = await loadLicenseGate();
    if (!gate) {
      onNotify?.(t('pending.pr.allowlist_load_failed', { defaultValue: '名单加载失败，请重试' }), 'warning');
    }
    return gate;
  }, [loadLicenseGate, onNotify, t]);

  // 表单态（新建或选中行载入；identifier/platforms 等以文本态编辑，保存时归一）。
  const [form, setForm] = useState<PendingDraftItem>(PENDING_EMPTY_DRAFT);
  const [aliasesText, setAliasesText] = useState('');
  const [platformsText, setPlatformsText] = useState('windows');
  const [publishersText, setPublishersText] = useState('');
  const [installDirsText, setInstallDirsText] = useState('');
  const [searchSubdirsText, setSearchSubdirsText] = useState('');
  const [identifiersText, setIdentifiersText] = useState('');

  const counts = useMemo(() => {
    const c: Record<PendingGroupId, number> = { draft: 0, submitted: 0, archived: 0 };
    for (const e of entries) c[entryGroup(e)] += 1;
    return c;
  }, [entries]);

  const visibleEntries = useMemo(
    () => entries.filter((e) => entryGroup(e) === activeGroup),
    [entries, activeGroup],
  );

  const previewPlatforms = useMemo(() => {
    return splitCsv(platformsText.toLowerCase());
  }, [platformsText]);

  const editingEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const loadIntoForm = (item: PendingDraftItem) => {
    setForm({ ...item });
    setAliasesText(item.aliases.join(', '));
    setPlatformsText(item.platforms.join(', '));
    setPublishersText(item.publishers.join(', '));
    setInstallDirsText(item.install_dirs.join('\n'));
    setSearchSubdirsText(item.search_subdirs.join('\n'));
    setIdentifiersText(stringifyIdentifiers(item.identifiers));
    setFormErrors({});
  };

  const handleStartCreate = () => {
    setIsCreating(true);
    setSelectedId(null);
    loadIntoForm(PENDING_EMPTY_DRAFT);
  };

  const handleSelectEntry = (id: string) => {
    const found = entries.find((e) => e.id === id);
    if (!found) return;
    setIsCreating(false);
    setSelectedId(id);
    setConfirmDeleteId(null);
    setPrUrlInput(found.pr_url ?? '');
    loadIntoForm(found.item);
  };

  const setField = <K extends keyof PendingDraftItem>(key: K, value: PendingDraftItem[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // owner/repo 键入时自动联动规范 id（D 档规范：id 永不可手动编辑，恒为 canonical(owner, repo)）
      if (key === 'owner' || key === 'repo') {
        const owner = key === 'owner' ? String(value) : prev.owner;
        const repo = key === 'repo' ? String(value) : prev.repo;
        if (owner.trim() && repo.trim()) {
          next.id = canonicalDraftId(owner, repo);
        }
      }
      return next;
    });
  };

  const collectFormItem = (): PendingDraftItem => ({
    ...form,
    id: canonicalDraftId(form.owner, form.repo),
    name: form.name.trim(),
    owner: form.owner.trim(),
    repo: form.repo.trim(),
    description: form.description.trim(),
    description_en: form.description_en.trim(),
    category: form.category.trim(),
    category_name: form.category_name.trim() || form.category.trim(),
    license: form.license.trim(),
    homepage: form.homepage.trim(),
    icon: form.icon.trim(),
    icon_bg: form.icon_bg.trim(),
    default_version: form.default_version.trim() || 'v0.1.0',
    aliases: splitCsv(aliasesText),
    platforms: splitCsv(platformsText.toLowerCase()),
    publishers: splitLines(publishersText),
    install_dirs: splitLines(installDirsText),
    search_subdirs: splitLines(searchSubdirsText),
    identifiers: parseIdentifiersText(identifiersText),
  });

  const errorText = (code: string): string => t(`pending.errors.${code}`, code);

  const handleCopyId = async () => {
    const idToCopy = form.id.trim() || expectedId;
    if (!idToCopy) return;
    const copied = await copyTextToClipboard(idToCopy);
    onNotify?.(
      t(copied ? 'pending.id_copied' : 'pending.pr.copy_failed', {
        defaultValue: copied ? `ID 已复制：${idToCopy}` : '复制失败',
        id: idToCopy,
      }),
      copied ? 'success' : 'warning',
    );
  };

  const handleDuplicateDraft = () => {
    if (!editingEntry) return;
    setIsCreating(true);
    setSelectedId(null);
    setConfirmDeleteId(null);
    setPrUrlInput('');
    const duplicatedItem: PendingDraftItem = {
      ...editingEntry.item,
      id: '', // 清空 id，修改 owner/repo 时自动联动新 id
    };
    loadIntoForm(duplicatedItem);
    onNotify?.(
      t('pending.duplicated_hint', { defaultValue: '已复制为新草稿模板，修改 owner/repo 后保存' }),
      'info',
    );
  };

  const handleSave = async () => {
    const item = collectFormItem();
    // 暂存档（DraftLenient）：仅校验身份，不卡 license/homepage/不完整字段；
    // 名单加载失败同样放行暂存（本就不查名单）。
    const errors = validatePendingDraft(item, 'draft');
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      onNotify?.(t('pending.fix_errors'), 'warning');
      return;
    }
    if (onSave) {
      await onSave(item);
    } else {
      setLocalEntries((prev) => {
        const now = Math.floor(Date.now() / 1000);
        const idx = prev.findIndex((e) => e.id === item.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], id: item.id, item, updated_at: now };
          return next;
        }
        return [...prev, { id: item.id, item, status: 'draft', pr_url: null, archived: false, updated_at: now }];
      });
    }
    setIsCreating(false);
    setSelectedId(item.id);
    onNotify?.(t('pending.saved', { id: item.id }), 'success');
  };

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      window.setTimeout(() => {
        setConfirmDeleteId((prev) => (prev === id ? null : prev));
      }, 4000);
      return;
    }
    if (onDelete) {
      await onDelete(id);
    } else {
      setLocalEntries((prev) => prev.filter((e) => e.id !== id));
    }
    setConfirmDeleteId(null);
    if (selectedId === id) {
      setSelectedId(null);
      setIsCreating(false);
    }
    onNotify?.(t('pending.deleted', { id }), 'info');
  };

  const handleMarkSubmitted = async (id: string) => {
    const url = prUrlInput.trim();
    if (!url || !url.startsWith('https://')) {
      onNotify?.(t('pending.errors.pr_url_scheme'), 'warning');
      return;
    }
    if (onMarkSubmitted) {
      await onMarkSubmitted(id, url);
    } else {
      setLocalEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, status: 'submitted' as const, pr_url: url } : e)),
      );
    }
    onNotify?.(t('pending.marked_submitted', { id }), 'success');
  };

  const flipLocalSubmitted = (id: string, url: string) => {
    setLocalEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'submitted' as const, pr_url: url } : e)),
    );
  };

  const openPrefillPage = (url: string) => {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  /**
   * Lane D 单卡“提交 PR”：先确保后端许可名单就绪（失败提示重试并中止，
   * 不回退本地名单）→ 提交档本地预检（与后端 SubmitStrict 同口径；
   * 占位 license 在此被拦，toast 指到 license 字段，不开页不标记）→ 复制 JSON →
   * 打开预填 URL（无 token 纯 URL）→ mark_submitted 存 URL 切到已提交。
   * URL 优先走后端，失败回退本地同形；标记失败 toast 后端原文并中止。
   */
  const handleSubmitPr = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || submittingId === id) return;
    const gate = await ensureLicenseGate();
    if (!gate) return;
    const strictErrors = validatePendingDraft(target.item, 'submit', gate);
    if (Object.keys(strictErrors).length > 0) {
      setFormErrors(strictErrors);
      onNotify?.(
        strictErrors.license
          ? t('pending.pr.license_fix_hint', { id })
          : t('pending.fix_errors'),
        'warning',
      );
      return;
    }
    setSubmittingId(id);
    try {
      const payload = buildSinglePrPayloadJson(target.item);
      const copied = await copyTextToClipboard(payload);
      onNotify?.(t(copied ? 'pending.pr.json_copied' : 'pending.pr.copy_failed'), copied ? 'success' : 'warning');
      let url = '';
      try {
        url = onGetPrUrl ? await onGetPrUrl(id) : buildLocalSinglePrUrl(target);
      } catch {
        url = buildLocalSinglePrUrl(target);
      }
      openPrefillPage(url);
      try {
        if (onMarkSubmitted) {
          await onMarkSubmitted(id, url);
        } else {
          flipLocalSubmitted(id, url);
        }
      } catch (e) {
        onNotify?.(e instanceof Error ? e.message : String(e), 'error');
        return;
      }
      onNotify?.(t('pending.marked_submitted', { id }), 'success');
    } finally {
      setSubmittingId(null);
    }
  };

  /** 二期批量候选：仅未归档未提交草稿（已提交不再重复进批）。 */
  const batchCandidates = useMemo(
    () => entries.filter((e) => !e.archived && e.status !== 'submitted'),
    [entries],
  );

  const toggleBatchSelected = (id: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /**
   * Lane D 二期批量栏：先确保后端许可名单就绪（失败提示重试并中止）→
   * 选中多条 → 提交档本地预检（整批任一条不过即拦下并点名，
   * 不开页不标记）→ 合并 JSON 数组 → 一个预填 URL（批量合一 PR）→
   * 逐条 mark_submitted（同 URL）。默认开启，showBatchBar=false 或栏内隐藏可关。
   */
  const handleBatchSubmit = async () => {
    const picked = batchCandidates.filter((e) => batchSelected.has(e.id));
    if (picked.length === 0 || batchBusy) {
      if (picked.length === 0) {
        onNotify?.(t('pending.pr.batch_need_selection'), 'warning');
      }
      return;
    }
    const gate = await ensureLicenseGate();
    if (!gate) return;
    const blocked = picked.filter(
      (e) => Object.keys(validatePendingDraft(e.item, 'submit', gate)).length > 0,
    );
    if (blocked.length > 0) {
      onNotify?.(
        t('pending.pr.batch_blocked', { ids: blocked.map((e) => e.id).join('、') }),
        'warning',
      );
      return;
    }
    setBatchBusy(true);
    try {
      const ids = picked.map((e) => e.id);
      const payload = buildBatchPrPayloadJson(picked.map((e) => e.item));
      const copied = await copyTextToClipboard(payload);
      onNotify?.(t(copied ? 'pending.pr.json_copied' : 'pending.pr.copy_failed'), copied ? 'success' : 'warning');
      let url = '';
      try {
        url = onGetBatchPrUrl ? await onGetBatchPrUrl(ids) : buildLocalBatchPrUrl(picked);
      } catch {
        url = buildLocalBatchPrUrl(picked);
      }
      openPrefillPage(url);
      try {
        for (const pid of ids) {
          if (onMarkSubmitted) {
            await onMarkSubmitted(pid, url);
          } else {
            flipLocalSubmitted(pid, url);
          }
        }
      } catch (e) {
        onNotify?.(e instanceof Error ? e.message : String(e), 'error');
        return;
      }
      setBatchSelected(new Set());
      onNotify?.(t('pending.pr.batch_submitted', { count: ids.length }), 'success');
    } finally {
      setBatchBusy(false);
    }
  };

  const showEditor = isCreating || editingEntry !== null;
  const isArchived = Boolean(editingEntry?.archived);
  const expectedId = form.owner.trim() && form.repo.trim() ? canonicalDraftId(form.owner, form.repo) : '';
  const currentId = form.id.trim() || expectedId;

  return (
    <ViewShell viewClass="pending-view">
      {/* 1. 页头：标题 + 计数 + 简明说明 + 右侧主操作“新建草稿” */}
      <div className="pending-header">
        <div className="pending-header-info">
          <h3 className="pending-header-title">
            <Inbox size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>{t('pending.title')}</span>
            {entries.length > 0 && (
              <span
                className="nav-badge"
                aria-label={t('pending.count_hint', { count: entries.length })}
                title={t('pending.count_hint', { count: entries.length })}
              >
                {entries.length}
              </span>
            )}
          </h3>
          <p className="pending-header-desc">
            {t('pending.subtitle')}
          </p>
        </div>
        <button type="button" className="btn-fluent btn-primary btn-sm" onClick={handleStartCreate}>
          <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('pending.new_draft')}</span>
        </button>
      </div>

      {/* 2. 状态 tabs 分组 */}
      <div className="segmented-group" role="tablist" aria-label={t('pending.title')} style={{ marginBottom: '12px' }}>
        {GROUP_META.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeGroup === id}
            className={`segmented-item ${activeGroup === id ? 'active' : ''}`}
            onClick={() => setActiveGroup(id)}
          >
            <Icon size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{t(`pending.groups.${id}`)}</span>
            <span className="segmented-count">{counts[id]}</span>
          </button>
        ))}
      </div>

      {/* 3. Lane D 二期批量栏：收起为次级工具条，按需展开候选与合并提交 */}
      {showBatchBar &&
        (batchHidden ? (
          <div style={{ marginBottom: '12px' }}>
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              onClick={() => setBatchHidden(false)}
            >
              <span>{t('pending.pr.show_batch')}</span>
            </button>
          </div>
        ) : (
          <div
            className="pending-batch-bar"
            data-testid="pending-batch-bar"
          >
            <div className="pending-batch-bar-header">
              <div className="pending-batch-bar-title-wrap">
                <Send size={13} strokeWidth={1.5} aria-hidden="true" className="pending-batch-icon" />
                <strong className="pending-batch-title">
                  {t('pending.pr.batch_title')}
                </strong>
                <span className="pending-batch-hint">
                  {t('pending.pr.batch_hint')}
                </span>
              </div>
              <div className="pending-batch-bar-actions">
                {batchSelected.size > 0 && (
                  <span className="pending-batch-count-badge">
                    {t('pending.pr.batch_selected', { count: batchSelected.size, defaultValue: `已选 ${batchSelected.size}` })}
                  </span>
                )}
                <button
                  type="button"
                  className="btn-fluent btn-ghost btn-sm"
                  onClick={() => setBatchExpanded((prev) => !prev)}
                  aria-expanded={batchExpanded}
                >
                  {batchExpanded ? (
                    <>
                      <ChevronUp size={13} strokeWidth={1.5} aria-hidden="true" />
                      <span>{t('pending.pr.batch_collapse', { defaultValue: '收起' })}</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" />
                      <span>{t('pending.pr.batch_expand', { defaultValue: '展开' })}</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn-fluent btn-ghost btn-sm"
                  onClick={() => setBatchHidden(true)}
                  title={t('pending.pr.hide_batch')}
                  aria-label={t('pending.pr.hide_batch')}
                >
                  <span>{t('pending.pr.hide_batch')}</span>
                </button>
              </div>
            </div>

            <div
              className="pending-batch-bar-body"
              style={{ display: batchExpanded ? 'flex' : 'none' }}
            >
              {batchCandidates.length === 0 ? (
                <div className="pending-batch-empty">{t('pending.group_empty_title')}</div>
              ) : (
                <>
                  <div className="pending-batch-candidate-list">
                    {batchCandidates.map((candidate) => {
                      const isSelected = batchSelected.has(candidate.id);
                      const name = candidate.item.name || candidate.id;
                      return (
                        <label
                          key={candidate.id}
                          className={`pending-batch-candidate-item ${isSelected ? 'selected' : ''}`}
                          title={`${name} (${candidate.id})`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleBatchSelected(candidate.id)}
                            aria-label={candidate.id}
                          />
                          <span className="pending-batch-candidate-name">
                            {name}
                          </span>
                          <span className="pending-batch-candidate-id">
                            {candidate.id}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="pending-batch-actions-row">
                    <div className="pending-batch-actions-right">
                      <button
                        type="button"
                        className="btn-fluent btn-ghost btn-sm"
                        onClick={() => setBatchSelected(new Set(batchCandidates.map((e) => e.id)))}
                      >
                        <span>{t('pending.pr.select_all')}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-fluent btn-ghost btn-sm"
                        disabled={batchSelected.size === 0}
                        onClick={() => setBatchSelected(new Set())}
                      >
                        <span>{t('pending.pr.clear_selection')}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-fluent btn-primary btn-sm"
                        data-testid="pending-batch-submit"
                        disabled={batchBusy || batchSelected.size === 0}
                        onClick={() => void handleBatchSubmit()}
                      >
                        <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                        <span>
                          {batchBusy
                            ? t('pending.pr.batch_submitting')
                            : t('pending.pr.batch_submit', { count: batchSelected.size })}
                        </span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}

      {/* 4. 主区：草稿全空时展示全局引导；有草稿时展示 master-detail 左右分栏 */}
      {entries.length === 0 && !isCreating ? (
        <FilterEmptyState
          icon={<Inbox size={28} strokeWidth={1.25} aria-hidden="true" />}
          title={t('pending.empty_title')}
          description={t('pending.empty_desc')}
          resetLabel={t('pending.new_draft')}
          onReset={handleStartCreate}
        />
      ) : (
        <div className="pending-layout">
          {/* 左：Master 草稿列表 */}
          <div className="pending-list" role="tabpanel" aria-label={t(`pending.groups.${activeGroup}`)}>
            {visibleEntries.length === 0 ? (
              <div className="pending-list-empty-inline">
                <Inbox size={22} strokeWidth={1.25} aria-hidden="true" style={{ opacity: 0.5 }} />
                <div style={{ fontWeight: 510, color: 'var(--text-secondary)' }}>{t('pending.group_empty_title')}</div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>{t('pending.group_empty_desc')}</div>
              </div>
            ) : (
              visibleEntries.map((entry) => {
                const selected = entry.id === selectedId;
                const isSubmitted = entryGroup(entry) === 'submitted';
                const isArchived = entryGroup(entry) === 'archived';
                return (
                  <div
                    key={entry.id}
                    className={`app-card pending-list-item ${selected ? 'selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    onClick={() => handleSelectEntry(entry.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectEntry(entry.id);
                      }
                    }}
                  >
                    <span className="pending-item-icon-box">
                      {isArchived ? (
                        <Archive size={14} strokeWidth={1.5} aria-hidden="true" />
                      ) : isSubmitted ? (
                        <Send size={14} strokeWidth={1.5} aria-hidden="true" />
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

          {/* 右：Detail 全字段编辑器 */}
          <div className="pending-editor">
            {!showEditor ? (
              <FilterEmptyState
                icon={<PencilLine size={24} strokeWidth={1.25} aria-hidden="true" />}
                title={t('pending.pick_hint_title')}
                description={t('pending.pick_hint_desc')}
                resetLabel={t('pending.new_draft')}
                variant="secondary"
                onReset={handleStartCreate}
              />
            ) : (
              <>
                {/* 实时卡片预览窗口（Draft Visual / Post-inclusion preview lane） */}
                <div className="pending-preview-lane">
                  <div className="pending-preview-header">
                    <div className="pending-preview-header-title">
                      <Eye size={13} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
                      <strong>草稿收录后预览</strong>
                      <span className="pending-preview-header-hint">随表单输入实时同步</span>
                    </div>
                    <div className="pending-preview-header-actions">
                      <span
                        className="app-tag"
                        style={{
                          border: '1px dashed var(--border-nav-active)',
                          color: 'var(--brand-primary)',
                          fontWeight: 600,
                        }}
                      >
                        自维护草稿
                      </span>
                      <button
                        type="button"
                        className="btn-fluent btn-secondary btn-sm"
                        onClick={() => setPreviewExpanded((prev) => !prev)}
                        style={{ padding: '2px 8px' }}
                      >
                        {previewExpanded ? (
                          <>
                            <ChevronUp size={12} strokeWidth={1.5} aria-hidden="true" />
                            <span>收起预览</span>
                          </>
                        ) : (
                          <>
                            <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
                            <span>展开预览</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {previewExpanded && (
                    <div className="pending-preview-body">
                      {/* 卡片主体：图标 + 标题 + owner/repo + 分类 + 平台 */}
                      <div className="pending-preview-main">
                        <div
                          className="pending-preview-icon-box"
                          style={{ backgroundColor: form.icon_bg.trim() || 'var(--bg-input)' }}
                        >
                          {form.icon.trim() &&
                          (form.icon.startsWith('http://') ||
                            form.icon.startsWith('https://') ||
                            form.icon.startsWith('data:')) ? (
                            <img
                              src={form.icon.trim()}
                              alt=""
                              onError={(e) => {
                                (e.currentTarget as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                              {(form.name.trim() || form.owner.trim() || form.id.trim() || '?').slice(0, 1).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="pending-preview-meta">
                          <div className="pending-preview-title-row">
                            <span className={`pending-preview-name ${!form.name.trim() ? 'pending-preview-empty' : ''}`}>
                              {form.name.trim() || '未填写应用名称'}
                            </span>
                            <span className="pending-preview-id-badge" title={form.id.trim() || expectedId}>
                              {form.id.trim() || expectedId || '未生成 id'}
                            </span>
                          </div>
                          <div className="pending-preview-owner-row">
                            {form.owner.trim() || form.repo.trim() ? (
                              <span>{form.owner.trim() || '—'} / {form.repo.trim() || '—'}</span>
                            ) : (
                              <span className="pending-preview-empty">未填写仓库 owner/repo</span>
                            )}
                            <span className="pending-item-dot" />
                            <span className={!form.category.trim() ? 'pending-preview-empty' : ''}>
                              {form.category_name.trim() || form.category.trim() || '未填写分类'}
                            </span>
                            {form.default_version.trim() && (
                              <>
                                <span className="pending-item-dot" />
                                <span>{form.default_version.trim()}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* 描述 */}
                      <p className={`pending-preview-desc ${!(form.description.trim() || form.description_en.trim()) ? 'pending-preview-empty' : ''}`}>
                        {form.description.trim() || form.description_en.trim() || '未填写应用描述（收录后将在此展示简要说明）'}
                      </p>

                      {/* 底部信息标签栏 */}
                      <div className="pending-preview-tags">
                        {/* 分类标签 */}
                        <span className={`pending-preview-tag ${!form.category.trim() ? 'pending-preview-empty' : ''}`} title="功能分类">
                          <Tag size={10} strokeWidth={1.5} aria-hidden="true" />
                          <span>{form.category_name.trim() || form.category.trim() || '未填写分类'}</span>
                        </span>

                        {/* 平台标签列表 */}
                        {previewPlatforms.length > 0 ? (
                          previewPlatforms.map((p) => {
                            const meta = PLATFORM_META[p as PlatformId];
                            return (
                              <span key={p} className="pending-preview-tag" title={`支持平台: ${meta?.label || p}`}>
                                <PlatformIcon platform={p} size={11} />
                                <span>{meta?.label || p}</span>
                              </span>
                            );
                          })
                        ) : (
                          <span className="pending-preview-tag pending-preview-empty">未填写平台</span>
                        )}

                        {/* 开源协议标签 */}
                        <span className={`pending-preview-tag ${!form.license.trim() ? 'pending-preview-empty' : ''}`} title="开源协议">
                          <ShieldCheck size={11} strokeWidth={1.5} aria-hidden="true" />
                          <span>{form.license.trim() || '未填写协议'}</span>
                        </span>

                        {/* 官网/主页标签 */}
                        {form.homepage.trim() ? (
                          <span className="pending-preview-tag" title={`官方主页: ${form.homepage}`}>
                            <Globe size={11} strokeWidth={1.5} aria-hidden="true" />
                            <a
                              href={form.homepage.trim()}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: 'inherit', textDecoration: 'none' }}
                            >
                              {form.homepage.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')}
                            </a>
                          </span>
                        ) : (
                          <span className="pending-preview-tag pending-preview-empty">未填写主页</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="app-card pending-editor-card">
                {/* 顶部标题栏 */}
                <div className="pending-editor-header">
                  <div className="pending-editor-title-wrap">
                    <PencilLine size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                    <strong
                      className="pending-editor-title"
                      title={isCreating ? undefined : editingEntry?.id}
                    >
                      {isCreating ? t('pending.new_draft') : editingEntry?.id}
                    </strong>
                    {editingEntry?.archived && (
                      <span className="nav-badge" title={t('pending.archived_badge')}>
                        {t('pending.archived_badge')}
                      </span>
                    )}
                    {!isCreating && editingEntry?.status === 'submitted' && (
                      <span className="nav-badge" style={{ color: 'var(--brand-primary)', borderColor: 'var(--brand-glow)' }}>
                        {t('pending.groups.submitted')}
                      </span>
                    )}
                  </div>
                  {!isCreating && (
                    <div className="pending-editor-header-actions">
                      <button
                        type="button"
                        className="btn-fluent btn-ghost btn-sm"
                        onClick={toggleShowCoords}
                        data-testid="pending-toggle-coords"
                        title={showCoords ? t('pending.hide_coords') : t('pending.show_coords')}
                        aria-label={showCoords ? t('pending.hide_coords') : t('pending.show_coords')}
                      >
                        {showCoords ? (
                          <>
                            <EyeOff size={13} strokeWidth={1.5} aria-hidden="true" />
                            <span>{t('pending.hide_coords_btn')}</span>
                          </>
                        ) : (
                          <>
                            <Eye size={13} strokeWidth={1.5} aria-hidden="true" />
                            <span>{t('pending.show_coords_btn')}</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* 分节 D：仓库标识与坐标（只读锁定） */}
                {(isCreating || showCoords) && (
                  <>
                    <div className="pending-section-header pending-section-header-static">
                      <div className="pending-section-title-wrap">
                        <ShieldCheck size={13} strokeWidth={1.5} aria-hidden="true" />
                        <span>仓库与标识（只读锁定）</span>
                      </div>
                    </div>

                    <label style={labelStyle}>
                      <span>{t('pending.fields.owner')}</span>
                      <input
                        className="input-fluent"
                        value={form.owner}
                        onChange={(e) => setField('owner', e.target.value)}
                        placeholder="rustdesk"
                        autoComplete="off"
                        readOnly={!isCreating || isArchived}
                      />
                      {formErrors.owner && <em style={errorStyle}>{errorText(formErrors.owner)}</em>}
                    </label>

                    <label style={labelStyle}>
                      <span>{t('pending.fields.repo')}</span>
                      <input
                        className="input-fluent"
                        value={form.repo}
                        onChange={(e) => setField('repo', e.target.value)}
                        placeholder="rustdesk"
                        autoComplete="off"
                        readOnly={!isCreating || isArchived}
                      />
                      {formErrors.repo && <em style={errorStyle}>{errorText(formErrors.repo)}</em>}
                    </label>

                    {!isCreating && (
                      <div className="pending-readonly-coord-hint">
                        <span>改名请复制为新草稿</span>
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
                          data-testid="pending-duplicate"
                          onClick={handleDuplicateDraft}
                          style={{ padding: '2px 8px', fontSize: '11px' }}
                        >
                          <span>复制为新草稿</span>
                        </button>
                      </div>
                    )}

                    <div style={labelStyle} className="pending-id-display">
                      <span>{t('pending.fields.id')}</span>
                      <div className="pending-id-badge-wrap">
                        <code className="pending-id-code">{currentId || '—'}</code>
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
                          data-testid="pending-copy-id"
                          onClick={() => void handleCopyId()}
                          style={{ padding: '2px 8px', fontSize: '11px' }}
                          title="复制应用标识 ID"
                        >
                          <span>复制</span>
                        </button>
                      </div>
                      {isCreating && expectedId && (
                        <span style={hintStyle}>
                          {t('pending.id_preview', { id: expectedId })}
                        </span>
                      )}
                      {formErrors.id && <em style={errorStyle}>{errorText(formErrors.id)}</em>}
                    </div>
                  </>
                )}

                {/* 分节 A：核心信息（核心必填，恒定展开，不可隐藏） */}
                <div className="pending-section-header pending-section-header-static">
                  <div className="pending-section-title-wrap">
                    <FileText size={13} strokeWidth={1.5} aria-hidden="true" />
                    <span>核心信息（必填）</span>
                    <span className="pending-section-count">6</span>
                  </div>
                </div>

                <label style={labelStyle}>
                  <span>{t('pending.fields.name')}</span>
                  <input
                    className="input-fluent"
                    value={form.name}
                    onChange={(e) => setField('name', e.target.value)}
                    placeholder={t('pending.placeholders.name')}
                    readOnly={isArchived}
                  />
                  {formErrors.name && <em style={errorStyle}>{errorText(formErrors.name)}</em>}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.description')}</span>
                  <textarea
                    className="input-fluent"
                    value={form.description}
                    onChange={(e) => setField('description', e.target.value)}
                    rows={2}
                    placeholder={t('pending.placeholders.description')}
                    readOnly={isArchived}
                  />
                  {formErrors.description && <em style={errorStyle}>{errorText(formErrors.description)}</em>}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.category')}</span>
                  <input
                    className="input-fluent"
                    value={form.category}
                    onChange={(e) => setField('category', e.target.value)}
                    placeholder="dev"
                    autoComplete="off"
                    readOnly={isArchived}
                  />
                  {formErrors.category && <em style={errorStyle}>{errorText(formErrors.category)}</em>}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.license')}</span>
                  <input
                    className="input-fluent"
                    value={form.license}
                    onChange={(e) => setField('license', e.target.value)}
                    placeholder="MIT"
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                  {formErrors.license && <em style={errorStyle}>{errorText(formErrors.license)}</em>}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.homepage')}</span>
                  <input
                    className="input-fluent"
                    value={form.homepage}
                    onChange={(e) => setField('homepage', e.target.value)}
                    placeholder="https://example.com"
                    inputMode="url"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                  {formErrors.homepage && <em style={errorStyle}>{errorText(formErrors.homepage)}</em>}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.default_version')}</span>
                  <input
                    className="input-fluent"
                    value={form.default_version}
                    onChange={(e) => setField('default_version', e.target.value)}
                    placeholder="v0.1.0"
                    autoComplete="off"
                    readOnly={isArchived}
                  />
                </label>

                {/* 分节 B：补充信息（可选补充，默认展开，允许折叠） */}
                <div
                  role="button"
                  tabIndex={0}
                  className="pending-section-header"
                  onClick={() => toggleSection('optional')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleSection('optional');
                    }
                  }}
                >
                  <div className="pending-section-title-wrap">
                    <AlignLeft size={13} strokeWidth={1.5} aria-hidden="true" />
                    <span>补充信息（可选）</span>
                    <span className="pending-section-count">4</span>
                  </div>
                  {openSections.optional ? (
                    <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
                  )}
                </div>

                <label style={{ ...labelStyle, display: openSections.optional ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.category_name')}</span>
                  <input
                    className="input-fluent"
                    value={form.category_name}
                    onChange={(e) => setField('category_name', e.target.value)}
                    placeholder={t('pending.placeholders.category_name')}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.optional ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.description_en')}</span>
                  <textarea
                    className="input-fluent"
                    value={form.description_en}
                    onChange={(e) => setField('description_en', e.target.value)}
                    rows={2}
                    placeholder={t('pending.placeholders.description_en')}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.optional ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.icon')}</span>
                  <input
                    className="input-fluent"
                    value={form.icon}
                    onChange={(e) => setField('icon', e.target.value)}
                    placeholder="https://…"
                    inputMode="url"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.optional ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.aliases')}</span>
                  <input
                    className="input-fluent"
                    value={aliasesText}
                    onChange={(e) => setAliasesText(e.target.value)}
                    placeholder={t('pending.placeholders.csv')}
                    readOnly={isArchived}
                  />
                </label>

                {/* 分节 C：高级运行时（默认折叠，允许展开） */}
                <div
                  role="button"
                  tabIndex={0}
                  className="pending-section-header"
                  onClick={() => toggleSection('runtime')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleSection('runtime');
                    }
                  }}
                >
                  <div className="pending-section-title-wrap">
                    <Sliders size={13} strokeWidth={1.5} aria-hidden="true" />
                    <span>运行时与目录（高级）</span>
                    <span className="pending-section-count">5</span>
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
                    className="input-fluent"
                    value={platformsText}
                    onChange={(e) => setPlatformsText(e.target.value)}
                    placeholder="windows, linux"
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.runtime ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.publishers')}</span>
                  <textarea
                    className="input-fluent"
                    value={publishersText}
                    onChange={(e) => setPublishersText(e.target.value)}
                    rows={2}
                    placeholder={t('pending.placeholders.lines')}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.runtime ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.install_dirs')}</span>
                  <textarea
                    className="input-fluent"
                    value={installDirsText}
                    onChange={(e) => setInstallDirsText(e.target.value)}
                    rows={2}
                    placeholder={t('pending.placeholders.lines')}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.runtime ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.search_subdirs')}</span>
                  <textarea
                    className="input-fluent"
                    value={searchSubdirsText}
                    onChange={(e) => setSearchSubdirsText(e.target.value)}
                    rows={2}
                    placeholder={t('pending.placeholders.lines')}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.runtime ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.identifiers')}</span>
                  <textarea
                    className="input-fluent"
                    value={identifiersText}
                    onChange={(e) => setIdentifiersText(e.target.value)}
                    rows={2}
                    placeholder="windows=rustdesk.exe"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                  <span style={hintStyle}>{t('pending.identifiers_hint')}</span>
                </label>

                {/* 固定卡片底部 Footer */}
                <div className="pending-editor-footer">
                  <div className="pending-editor-footer-actions">
                    <button
                      type="button"
                      className="btn-fluent btn-primary btn-sm"
                      onClick={handleSave}
                      disabled={isArchived}
                      title={isArchived ? '已归档只读，不可修改保存' : undefined}
                    >
                      {t('pending.save')}
                    </button>
                    {!isCreating && editingEntry && !isArchived && (
                      <button
                        type="button"
                        className="btn-fluent btn-secondary btn-sm"
                        onClick={() => handleDelete(editingEntry.id)}
                        title={t('pending.delete_hint')}
                      >
                        <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
                        <span>
                          {confirmDeleteId === editingEntry.id ? t('pending.confirm_delete') : t('pending.delete')}
                        </span>
                      </button>
                    )}
                    {isArchived && (
                      <span className="pending-archived-hint">
                        已归档草稿为只读，改名或修改请使用“复制为新草稿”
                      </span>
                    )}
                    {!isCreating && editingEntry && !isArchived && (
                      <button
                        type="button"
                        className="btn-fluent btn-primary btn-sm"
                        data-testid="pending-submit-pr"
                        disabled={submittingId === editingEntry.id}
                        onClick={() => void handleSubmitPr(editingEntry.id)}
                        title={t('pending.pr.json_copied')}
                        style={{ marginLeft: 'auto' }}
                      >
                        <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                        <span>
                          {submittingId === editingEntry.id
                            ? t('pending.pr.submitting')
                            : t('pending.pr.submit_pr')}
                        </span>
                      </button>
                    )}
                  </div>

                  {!isCreating && editingEntry && !isArchived && (
                    <div className="pending-editor-footer-manual">
                      <div className="pending-manual-label">{t('pending.submit_title')}</div>
                      <div className="pending-manual-row">
                        <input
                          className="input-fluent"
                          style={{ flex: '1 1 200px' }}
                          value={prUrlInput}
                          onChange={(e) => setPrUrlInput(e.target.value)}
                          placeholder="https://github.com/…/pull/…"
                          inputMode="url"
                          spellCheck={false}
                          aria-label={t('pending.submit_title')}
                        />
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
                          onClick={() => handleMarkSubmitted(editingEntry.id)}
                        >
                          <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                          <span>{t('pending.mark_submitted')}</span>
                        </button>
                      </div>
                      {editingEntry.pr_url && (
                        <div className="pending-editor-pr-link">
                          <Link2 size={12} strokeWidth={1.5} aria-hidden="true" style={{ verticalAlign: '-2px' }} />{' '}
                          <a
                            href={editingEntry.pr_url}
                            target="_blank"
                            rel="noreferrer"
                            title={t('pending.pr.open_pr')}
                            aria-label={t('pending.pr.open_pr')}
                          >
                            {editingEntry.pr_url}
                          </a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
          </div>
        </div>
      )}
    </ViewShell>
  );
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: 'var(--font-sm)',
  color: 'var(--text-secondary)',
  marginBottom: '8px',
  minWidth: 0,
};

const hintStyle: React.CSSProperties = {
  fontSize: 'var(--font-xs)',
  color: 'var(--text-tertiary)',
  minWidth: 0,
  overflowWrap: 'anywhere',
};

const errorStyle: React.CSSProperties = {
  fontSize: 'var(--font-xs)',
  color: 'var(--text-primary)',
  fontStyle: 'normal',
  borderLeft: '2px solid var(--text-primary)',
  paddingLeft: '6px',
};
