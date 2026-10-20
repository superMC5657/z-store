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
  PackageCheck,
  PencilLine,
  Send,
  ShieldCheck,
  Sliders,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react';
import { FilterEmptyState, ViewShell } from './ViewShell';
import { AppCard } from '../components/AppCard';
import type { AppSummary } from '../types';
import type { DraftEntry, DraftItem, DraftStatus } from '../services/custom/types';
import { itemToSummary } from '../services/custom/mappers';
import { PlatformIcon } from '../components/icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../lib/platformFilter';
import {
  copyTextToClipboard,
  getLicenseAllowlist,
  type LicenseAllowlistResult,
} from '../services/api/catalog';
import { tauriApi } from '../services/api';
import { resolveFallbackOpener } from '../utils/browserLockdown';
import { isCollectedStatus, isLocalLibraryStatus } from '../app/selectors';
import {
  getPendingSectionPrefs,
  getPendingShowCoordsPref,
  PENDING_SHOW_COORDS_EVENT,
  PENDING_SHOW_COORDS_EVENT_LEGACY,
  setPendingSectionPrefs,
  setPendingShowCoordsPref,
} from '../lib/pendingPrefs';

export type { LicenseAllowlistResult };

/**
 * 预填 URL 长度门限（判定口径为编码后预填链接全长，含 percent-encoding 膨胀；
 * 与 Spec §5 对齐，阈值 8000）：
 * 超过即提示分批提交，单条/批量同口径；超长时优先复制后端产出的提交载荷
 * （前端不拼装 JSON），再照常尝试打开预填页；载荷不可得则退化为复制链接。
 */
export const PREFILL_URL_LENGTH_LIMIT = 8000;

/**
 * 待收录页（UI 层，自维护草稿 overlay 前端）。
 *
 * - 本文件只管 UI，不直调任何 Tauri 命令（许可名单经
 *   `services/api/catalog.getLicenseAllowlist` 封装调用，无字面量命令名直调，
 *   见 noDirectInvoke.test.ts；命令表驱动收敛于 CMD）。
 * - 许可名单唯一源头为后端只读命令：本文件不保留任何硬编码名单；
 *   暂存走 draft 档（不查名单），提交/预填 Issue 前拉取后端名单做 submit 档校验；
 *   加载失败放行暂存、提交提示重试。
 * - 受控/非受控双模：传入 `entries` 即为受控（直接透传后端列表），
 *   缺席时走内部本地态（浏览器预览/单测可独立渲染编辑）。
 * - 设计走 Linear 去彩单色：仅用文本层级 + 边框 + 单色图标，不引入彩色语义。
 */

/**
 * 草稿领域形状（唯一定义见 `services/custom/types.ts`）：
 * 本视图保留同名重导出，既有调用方与测试 import 不需迁移。
 */
export type PendingDraftItem = DraftItem;

/** 草稿状态（`local_collected` 与 `collected` 同义）。 */
type PendingDraftStatus = DraftStatus;

/** 收录态判定唯一口径收敛于 selectors（本视图仅重导出供内部复用）。 */
const isPendingCollectedStatus = isCollectedStatus;

/**
 * 待收录草稿转富卡展示态（collected/submitted/archived 右侧富卡化复用 AppCard）：
 * 黄标只属于收录及其后链路（由 mappers 投影决定，草稿无 source）；
 * 投影唯一口径在 `services/custom/mappers`。
 */
export function pendingDraftToAppSummary(
  item: PendingDraftItem,
  status: PendingDraftStatus,
  archived?: boolean,
): AppSummary & { status: string; archived?: boolean } {
  return itemToSummary(item, status, archived);
}

/**
 * 待收录草稿简介按当前语言取展示文案（列表/富卡预览/空态共用）：
 * - 英文环境优先 description_en，非中文环境外优先 description；
 * - 主语言为空回退另一语言，两空返回 ''（调用方以 trends.no_desc 兜底，不新增文案）；
 * - 仅 trim 判空，不改表单两框可编辑性。
 */
export function resolvePendingDraftDescription(
  item: Pick<PendingDraftItem, 'description' | 'description_en'>,
  language?: string,
): string {
  const zh = item.description.trim();
  const en = item.description_en.trim();
  const isEn = typeof language === 'string' && language.toLowerCase().startsWith('en');
  if (isEn) return en || zh;
  return zh || en;
}

/** 视图条目 = 草稿领域形状（唯一定义见 `services/custom/types.ts`）。 */
export type CustomDraftEntry = DraftEntry;

type PendingGroupId = 'draft' | 'library' | 'archived';

/**
 * 「本地收录」内部分段（Issue 进度）：全部 = 收录系 + submitted；
 * 待提交 = 收录系（collected/local_collected）；已提交 = submitted。
 */
type PendingSegmentId = 'all' | 'to_submit' | 'submitted';

interface PendingViewProps {
  /** 受控草稿列表（缺席时走内部本地态）。 */
  entries?: CustomDraftEntry[];
  /** 初始草稿（非受控模式种子，故事/单测用）。 */
  initialEntries?: CustomDraftEntry[];
  /** 保存回调（缺席时仅更新本地态）。 */
  onSave?: (item: PendingDraftItem) => void | Promise<void>;
  /** 删除回调（二次确认由本组件完成，后端直接删）。 */
  onDelete?: (id: string) => void | Promise<void>;
  /** 标记已提交回调（缺席时仅翻本地态）。 */
  onMarkSubmitted?: (id: string, prUrl: string) => void | Promise<void>;
  /** 收录进本地回调（缺席时本地翻 collected 态；App 接入后透传 tauriApi.collectLocalApp）。 */
  onCollectLocal?: (id: string) => void | Promise<void>;
  /** 退回草稿回调（collected 退回 draft；App 透传 tauriApi.revertCollectedApp 落盘，失败抛错由本组件 toast）。 */
  onRevertToDraft?: (id: string) => void | Promise<void>;
  /**
   * 标记为未提交回调（submitted → collected，pr_url 清空；App 透传 tauriApi.withdrawSubmitted）。
   * 缺席时不渲染该动作（浏览器预览/单测无后端写入即不展示）。
   */
  onWithdrawSubmitted?: (id: string) => void | Promise<void>;
  /**
   * 单条预填 URL 提供方（App 透传 tauriApi.getCustomAppPrUrl；
   * 缺席时用本地同形兜底，浏览器预览/单测可用）。
   */
  onGetPrUrl?: (id: string) => Promise<string>;
  /**
   * 批量预填 URL 提供方（App 透传 tauriApi.getCustomAppsBatchPrUrl；
   * 缺席时用本地同形兜底）。
   */
  onGetBatchPrUrl?: (ids: string[]) => Promise<string>;
  /**
   * 单条提交载荷（后端 `get_custom_app_pr_payload` 产出的 JSON 对象文本；
   * 前端只原样复制，不自行拼装/格式化）。预填链接超长时优先复制它。
   */
  onGetPrPayload?: (id: string) => Promise<string>;
  /**
   * 批量提交载荷（后端 `get_custom_apps_batch_pr_payload` 产出的 JSON 数组文本；
   * 前端只原样复制）。批量预填链接超长时优先复制它。
   */
  onGetBatchPrPayload?: (ids: string[]) => Promise<string>;
  /**
   * 许可名单提供方（后端只读命令的前端封装；
   * 缺席时默认走 `getLicenseAllowlist`，单测可注入桩）。
   * 启动/提交前拉取，失败不回退写死名单（暂存放行、提交提示重试）。
   */
  onGetLicenseAllowlist?: () => Promise<LicenseAllowlistResult>;
  /** 批量提交入口开关（默认开启，传 false 隐藏本地收录列表工具行批量按钮与列表多选；开启时也仅本地收录分组可见）。 */
  showBatchBar?: boolean;
  /** 轻提示通道（缺席时静默）。 */
  onNotify?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

// 兼容再导出：历史调用方仍可从本视图 import 该键，实际收容于 `lib/pendingPrefs`（新代码请直引 lib）。
export { PENDING_SHOW_COORDS_STORAGE_KEY } from '../lib/pendingPrefs';

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
  install_dirs: [],
  search_subdirs: [],
  publishers: [],
  platforms: ['windows'],
  identifiers: {},
};

/**
 * 协议归一（与后端 `normalize_license` 逐字符同口径）：去首尾空白 → 大写 →
 * 每个空格/下划线单独折 `-`（连续空白因此各出一个 `-`，不做 run 折叠）→
 * 尾 `+` 视为或后续版本。
 */
export function normalizeLicense(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/[ _]/g, '-');
  if (s.endsWith('+')) {
    s = s.slice(0, -1);
    if (!s.endsWith('-OR-LATER')) s += '-OR-LATER';
  }
  return s;
}

/**
 * 后端许可名单输入（经 `get_license_allowlist` 拉取的唯一源头）：
 * 完整快照、纯名单数组（视为门禁开）、`Set` 均可；`null/undefined` 表示
 * 名单未加载——调用方不得回退写死名单（提交提示重试，暂存直接放行）。
 */
type LicenseAllowlistInput =
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

type PendingDraftErrors = Partial<Record<'id' | 'name' | 'owner' | 'repo' | 'description' | 'category' | 'homepage' | 'license', string>>;

/**
 * 草稿校验档位（与后端 `ValidateMode` 同语义）：
 * - `draft`：暂存档，仅校验身份（`id==canonical` 且与 `owner/repo` 对齐）；
 *   `license` 占位/空 `homepage`/不完整字段均放行，不触许可名单；
 * - `submit`：提交档，全量校验（必填 + `homepage` http(s) + 许可名单 D1），
 *   名单取后端 `get_license_allowlist` 快照。
 */
type PendingValidateMode = 'draft' | 'submit';

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
    // 与 Rust 同口径：坐标不可含空白（否则 id 归一后与 owner/repo 失配）。
    if (/\s/.test(item.owner) || /\s/.test(item.repo)) {
      errors.owner = errors.owner ?? 'coord_whitespace';
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
  // 归档优先（权威已交给远端）；库内成员 = collected 系 + submitted，其余（draft/未知）归草稿。
  if (e.archived) return 'archived';
  if (isLocalLibraryStatus(e.status)) return 'library';
  return 'draft';
}

/** 库内行的 Issue 进度分段；非库内行返回 null（不参与分段过滤）。 */
function entrySegment(e: CustomDraftEntry): Exclude<PendingSegmentId, 'all'> | null {
  if (e.archived) return null;
  if (e.status === 'submitted') return 'submitted';
  if (isPendingCollectedStatus(e.status)) return 'to_submit';
  return null;
}

/** submitted（已提交）判定：归档行优先只读，不再按 submitted 处理。 */
function isSubmittedEntry(e: CustomDraftEntry): boolean {
  return !e.archived && e.status === 'submitted';
}

const GROUP_META: ReadonlyArray<{ id: PendingGroupId; icon: typeof Inbox }> = [
  { id: 'draft', icon: FilePlus2 },
  { id: 'library', icon: PackageCheck },
  { id: 'archived', icon: Archive },
];

const SEGMENT_META: ReadonlyArray<{ id: PendingSegmentId }> = [
  { id: 'all' },
  { id: 'to_submit' },
  { id: 'submitted' },
];

export const PendingView: React.FC<PendingViewProps> = ({
  entries: controlledEntries,
  initialEntries = [],
  onSave,
  onDelete,
  onMarkSubmitted,
  onCollectLocal,
  onRevertToDraft,
  onWithdrawSubmitted,
  onGetPrUrl,
  onGetBatchPrUrl,
  onGetPrPayload,
  onGetBatchPrPayload,
  onGetLicenseAllowlist,
  showBatchBar = true,
  onNotify,
}) => {
  const { t, i18n } = useTranslation();
  const [localEntries, setLocalEntries] = useState<CustomDraftEntry[]>(initialEntries);
  const entries = controlledEntries ?? localEntries;
  const [activeGroup, setActiveGroup] = useState<PendingGroupId>('draft');
  const [activeSegment, setActiveSegment] = useState<PendingSegmentId>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [prUrlInput, setPrUrlInput] = useState('');
  const [formErrors, setFormErrors] = useState<PendingDraftErrors>({});
  // 单卡提交/收录忙态：提交中 id + 收录中 id + 批量选中/提交中（避免重复提交）。
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [confirmWithdrawId, setConfirmWithdrawId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(true);

  /**
   * 顶层三态切换（draft/library/archived）：
   * 右侧详情 + 底部批量栏 + 操作按钮随 activeGroup 联动，
   * 切 Tab 即重置跨分组选中（含新建态与二次确认态）与分段（回默认「全部」），无选中走空态提示。
   */
  const handleGroupChange = (group: PendingGroupId) => {
    if (group === activeGroup) return;
    setActiveGroup(group);
    setActiveSegment('all');
    setSelectedId(null);
    setIsCreating(false);
    setConfirmDeleteId(null);
    setConfirmRevertId(null);
    setConfirmWithdrawId(null);
    setPrUrlInput('');
    setFormErrors({});
    setBatchSelected(new Set());
  };

  /** 分段切换沿用切 Tab 的重置语义（选中/表单/报错/批量选择归零）。 */
  const handleSegmentChange = (segment: PendingSegmentId) => {
    if (segment === activeSegment) return;
    setActiveSegment(segment);
    setSelectedId(null);
    setIsCreating(false);
    setConfirmDeleteId(null);
    setConfirmRevertId(null);
    setConfirmWithdrawId(null);
    setPrUrlInput('');
    setFormErrors({});
    setBatchSelected(new Set());
  };

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
    window.addEventListener(PENDING_SHOW_COORDS_EVENT, handler);
    window.addEventListener(PENDING_SHOW_COORDS_EVENT_LEGACY, handler);
    return () => {
      window.removeEventListener(PENDING_SHOW_COORDS_EVENT, handler);
      window.removeEventListener(PENDING_SHOW_COORDS_EVENT_LEGACY, handler);
    };
  }, []);

  const toggleShowCoords = () => {
    const next = !showCoords;
    setShowCoords(next);
    setPendingShowCoordsPref(next);
  };

  // 表单 B/C 分节的展开/收起偏好（localStorage 持久化，A 核心必填不许折叠隐藏；
  // B 键名为 supplemental，旧 `optional` 形态由共享模块解析兼容）
  const [openSections, setOpenSections] = useState(() => getPendingSectionPrefs());

  const toggleSection = (key: 'supplemental' | 'runtime') => {
    setOpenSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setPendingSectionPrefs(next);
      return next;
    });
  };

  // 许可名单（唯一源头为后端只读命令）：启动预取 + 提交前兜底拉取。
  // 加载失败不回退任何本地名单：暂存（draft 档）本就不查名单直接放行；
  // 提交/预填前拿不到名单则提示重试并中止。
  // 逐框内联校验用快照（不每键 IPC）：licenseGateSnapshot 为已预取快照，
  // 未就绪时按 disabled 口径暂不标 osi/gate_unavailable（仍保留 required）。
  const [licenseGateSnapshot, setLicenseGateSnapshot] = useState<LicenseAllowlistResult | null>(null);
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
  // 快照同步给逐框校验：就绪即存快照，不每键 IPC。
  useEffect(() => {
    void loadLicenseGate().then((g) => {
      if (g) setLicenseGateSnapshot(g);
    });
  }, [loadLicenseGate]);

  // 提交/预填前确保名单就绪：拿不到则提示重试并返回 null（调用方中止，不开页不标记）。
  const ensureLicenseGate = useCallback(async (): Promise<LicenseAllowlistResult | null> => {
    const gate = await loadLicenseGate();
    if (!gate) {
      onNotify?.(t('pending.pr.allowlist_load_failed', { defaultValue: '名单加载失败，请重试' }), 'warning');
    } else {
      setLicenseGateSnapshot(gate);
    }
    return gate;
  }, [loadLicenseGate, onNotify, t]);

  // 表单态（新建或选中行载入；identifier/platforms 等以文本态编辑，保存时归一）。
  const [form, setForm] = useState<PendingDraftItem>(PENDING_EMPTY_DRAFT);
  const [aliasesText, setAliasesText] = useState('');
  const [platformsText, setPlatformsText] = useState('windows');
  const [identifiersText, setIdentifiersText] = useState('');

  // 逐框校验快照口径：已预取快照即用严格校验，未就绪按 disabled 暂不标 osi/gate（仍保留 required）。
  const effectiveGate: LicenseAllowlistInput = useMemo(
    () => licenseGateSnapshot ?? { enabled: false, allowed: [] },
    [licenseGateSnapshot],
  );

  // 当前表单归一后的 submit 档 live 校验（文本态字段归一后参验，不新增阻塞项）。
  const liveSubmitItem = useMemo((): PendingDraftItem => {
    const f = form;
    return {
      ...f,
      id: f.id.trim() ? f.id.trim() : canonicalDraftId(f.owner, f.repo),
      name: f.name.trim(),
      owner: f.owner.trim(),
      repo: f.repo.trim(),
      description: f.description.trim(),
      description_en: f.description_en.trim(),
      category: f.category.trim(),
      category_name: f.category_name.trim() || f.category.trim(),
      license: f.license.trim(),
      homepage: f.homepage.trim(),
      icon: f.icon.trim(),
      icon_bg: f.icon_bg.trim(),
      default_version: f.default_version.trim() || 'v0.1.0',
      aliases: splitCsv(aliasesText),
      platforms: splitCsv(platformsText.toLowerCase()),
      // 草稿即 catalog.json 单个应用 JSON：模板无 publishers/install_dirs/search_subdirs 时不出现，恒 []（已存旧值不迁移，展示/载荷照旧）。
      publishers: [],
      install_dirs: [],
      search_subdirs: [],
      identifiers: parseIdentifiersText(identifiersText),
    };
  }, [form, aliasesText, platformsText, identifiersText]);

  const liveSubmitErrors = useMemo(
    () => validatePendingDraft(liveSubmitItem, 'submit', effectiveGate),
    [liveSubmitItem, effectiveGate],
  );
  const hasSubmitErrors = Object.keys(liveSubmitErrors).length > 0;
  const hasLicenseSubmitError = Boolean(liveSubmitErrors.license);

  const counts = useMemo(() => {
    const c: Record<PendingGroupId, number> = { draft: 0, library: 0, archived: 0 };
    for (const e of entries) c[entryGroup(e)] += 1;
    return c;
  }, [entries]);

  // 内层过滤计数：与 counts.library 同源（库内每条必属 to_submit 或 submitted），
  // 让「全部 / 待提交 / 已提交」读作数据过滤而非第二层导航。
  const segmentCounts = useMemo(() => {
    const c: Record<PendingSegmentId, number> = { all: 0, to_submit: 0, submitted: 0 };
    for (const e of entries) {
      if (entryGroup(e) !== 'library') continue;
      c.all += 1;
      const seg = entrySegment(e);
      if (seg) c[seg] += 1;
    }
    return c;
  }, [entries]);

  const visibleEntries = useMemo(
    () =>
      entries.filter((e) => {
        if (entryGroup(e) !== activeGroup) return false;
        if (activeGroup !== 'library' || activeSegment === 'all') return true;
        return entrySegment(e) === activeSegment;
      }),
    [entries, activeGroup, activeSegment],
  );

  const previewPlatforms = useMemo(() => {
    return splitCsv(platformsText.toLowerCase());
  }, [platformsText]);

  const editingEntry = useMemo(() => {
    const found = entries.find((e) => e.id === selectedId) ?? null;
    // 跨 Tab/分段选中重置兜底：选中行不在当前 Tab（或不在当前分段）时视为无选中，走空态提示。
    if (found && !isCreating) {
      if (entryGroup(found) !== activeGroup) return null;
      if (activeGroup === 'library' && activeSegment !== 'all' && entrySegment(found) !== activeSegment) {
        return null;
      }
    }
    return found;
  }, [entries, selectedId, activeGroup, activeSegment, isCreating]);

  const loadIntoForm = (item: PendingDraftItem) => {
    setForm({ ...item });
    setAliasesText(item.aliases.join(', '));
    setPlatformsText(item.platforms.join(', '));
    setIdentifiersText(stringifyIdentifiers(item.identifiers));
    setFormErrors({});
  };

  const handleStartCreate = () => {
    // 新建草稿归 draft 分组：切 Tab 即进草稿态，避免在库内/归档展开错配表单。
    setActiveGroup('draft');
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
    setConfirmWithdrawId(null);
    setPrUrlInput(found.pr_url ?? '');
    loadIntoForm(found.item);
  };

  const setField = <K extends keyof PendingDraftItem>(key: K, value: PendingDraftItem[K]) => {
    // owner/repo 键入仅在 id 为空或仍等于上一次联动值时跟随填充；
    // 手输（偏离上次 canonical）一律保留，不逐键改写。
    const prev = form;
    const next = { ...prev, [key]: value };
    if (key === 'owner' || key === 'repo') {
      const owner = key === 'owner' ? String(value) : prev.owner;
      const repo = key === 'repo' ? String(value) : prev.repo;
      if (owner.trim() && repo.trim()) {
        const prevCanonical =
          prev.owner.trim() && prev.repo.trim() ? canonicalDraftId(prev.owner, prev.repo) : '';
        if (!prev.id.trim() || prev.id.trim() === prevCanonical) {
          next.id = canonicalDraftId(owner, repo);
        }
      }
    }
    setForm(next);
    // 逐框即时校验：对归一后表单跑 submit 档（license 用快照，不每键 IPC）。
    const nextItem: PendingDraftItem = {
      ...next,
      id: next.id.trim() ? next.id.trim() : canonicalDraftId(next.owner, next.repo),
      name: next.name.trim(),
      owner: next.owner.trim(),
      repo: next.repo.trim(),
      description: next.description.trim(),
      description_en: next.description_en.trim(),
      category: next.category.trim(),
      category_name: next.category_name.trim() || next.category.trim(),
      license: next.license.trim(),
      homepage: next.homepage.trim(),
      icon: next.icon.trim(),
      icon_bg: next.icon_bg.trim(),
      default_version: next.default_version.trim() || 'v0.1.0',
      aliases: splitCsv(aliasesText),
      platforms: splitCsv(platformsText.toLowerCase()),
      publishers: [],
      install_dirs: [],
      search_subdirs: [],
      identifiers: parseIdentifiersText(identifiersText),
    };
    setFormErrors(validatePendingDraft(nextItem, 'submit', effectiveGate));
  };

  // 文本态字段变更：仅归一后参验，不新增阻塞项；仍刷新 submit 档内联。
  const handleTextFieldChange = (
    key: 'aliases' | 'platforms' | 'identifiers',
    value: string,
  ) => {
    if (key === 'aliases') setAliasesText(value);
    else if (key === 'platforms') setPlatformsText(value);
    else setIdentifiersText(value);
    const nextAliases = key === 'aliases' ? value : aliasesText;
    const nextPlatforms = key === 'platforms' ? value : platformsText;
    const nextIdentifiers = key === 'identifiers' ? value : identifiersText;
    const nextItem: PendingDraftItem = {
      ...form,
      id: form.id.trim() ? form.id.trim() : canonicalDraftId(form.owner, form.repo),
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
      aliases: splitCsv(nextAliases),
      platforms: splitCsv(nextPlatforms.toLowerCase()),
      publishers: [],
      install_dirs: [],
      search_subdirs: [],
      identifiers: parseIdentifiersText(nextIdentifiers),
    };
    setFormErrors(validatePendingDraft(nextItem, 'submit', effectiveGate));
  };

  // 通用失焦校验：对归一后表单跑 submit 档，合并进内联（不 toast）。
  const handleFieldBlur = () => {
    setFormErrors(validatePendingDraft(collectFormItem(), 'submit', effectiveGate));
  };

  // id 失焦校验（DraftLenient 口径：id==canonical 且与 owner/repo 对齐）。
  // 仅Inline提示期望 canonical（复用 id_preview 文案），不改写手输。
  const handleIdBlur = () => {
    if (!form.owner.trim() || !form.repo.trim()) return;
    const expected = canonicalDraftId(form.owner, form.repo);
    const actual = form.id.trim();
    if (actual && (actual !== expected || actual !== actual.toLowerCase())) {
      setFormErrors((prev) => ({ ...prev, id: 'id_mismatch' }));
    } else if (actual === expected) {
      setFormErrors((prev) => {
        if (!prev.id) return prev;
        const next = { ...prev };
        delete next.id;
        return next;
      });
    }
  };

  const collectFormItem = (): PendingDraftItem => ({
    ...form,
    // 不静默丢弃手输 id——非空即原样保留（仅去首尾空格，大小写/内部空格留给校验），
    // 为空才回退 canonical；非规范手输由 draft 档校验拦下（id_mismatch），不直接改写。
    id: form.id.trim() ? form.id.trim() : canonicalDraftId(form.owner, form.repo),
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
    // 草稿即 catalog.json 单个应用 JSON：三字段恒 []，已存旧值不迁移、不回填表单。
    publishers: [],
    install_dirs: [],
    search_subdirs: [],
    identifiers: parseIdentifiersText(identifiersText),
  });

  const errorText = (code: string): string => t(`pending.errors.${code}`, code);

  // 首错定位：按表单顺序找首个错误 key，滚动到复用的 errorStyle 内联槽位并聚焦输入。
  // 八个校验键均在常显区（D 坐标 + A 核心），无需展开折叠节；折叠节字段不阻塞。
  const focusFirstError = (errors: PendingDraftErrors) => {
    const order: Array<keyof PendingDraftErrors> = [
      'owner',
      'repo',
      'id',
      'name',
      'description',
      'category',
      'license',
      'homepage',
    ];
    const first = order.find((k) => errors[k]);
    if (!first) return;
    window.setTimeout(() => {
      const el = document.querySelector(`[data-testid="pending-error-${first}"]`);
      if (!el) return;
      try {
        (el as HTMLElement).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
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
  };

  const scrollToBatchBlocked = () => {
    window.setTimeout(() => {
      const el = document.querySelector('[data-testid="pending-batch-blocked"]');
      if (!el) return;
      try {
        (el as HTMLElement).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      } catch {
        /* 忽略 */
      }
    }, 0);
  };

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
    // 复制为新草稿归 draft 分组：切回草稿 Tab 再展新建表单。
    setActiveGroup('draft');
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
    // 复制/手输撞已存在 id：warning 提示并中断，不静默建第二条（也不静默覆盖）。
    if (isCreating && entries.some((e) => e.id === item.id)) {
      onNotify?.(
        t('pending.duplicated_hint', { defaultValue: `已存在相同 ID：${item.id}，请修改 owner/repo 后再保存` }),
        'warning',
      );
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
    // 保存后留在 draft 分组（新建/编辑均为草稿语义），避免切 Tab 后左右错配。
    setActiveGroup('draft');
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
      flipLocalSubmitted(id, url);
    }
    // 手动标记后切到本地收录 · 已提交：富卡仅展 Issue 链接，不再重复提交。
    setActiveGroup('library');
    setActiveSegment('submitted');
    onNotify?.(t('pending.marked_submitted', { id }), 'success');
  };

  const flipLocalSubmitted = (id: string, url: string) => {
    setLocalEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'submitted' as const, pr_url: url } : e)),
    );
  };

  const flipLocalCollected = (id: string) => {
    setLocalEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'collected' as const } : e)),
    );
  };

  const flipLocalReverted = (id: string) => {
    setLocalEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'draft' as const } : e)),
    );
    setConfirmRevertId((prev) => (prev === id ? null : prev));
  };

  /**
   * 本地收录退回草稿：二次确认复用删除确认形态（首点置确认态 4s，次点执行）；
   * 有回调走后端落盘（App 透传 revert，失败抛错 toast 不静默），缺席仅本地预览翻 draft 态；toast 复用现有风格。
   * 退回后停留本地收录页（不跳 Tab）：选中清空或落到下一条同组行，由调用方切 Tab 回草稿查看。
   */
  const handleRevertToDraft = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || revertingId === id) return;
    if (target.archived) return;
    if (!isPendingCollectedStatus(target.status)) return;
    if (confirmRevertId !== id) {
      setConfirmRevertId(id);
      window.setTimeout(() => {
        setConfirmRevertId((prev) => (prev === id ? null : prev));
      }, 4000);
      return;
    }
    setRevertingId(id);
    try {
      if (onRevertToDraft) {
        await onRevertToDraft(id);
      } else {
        flipLocalReverted(id);
      }
      // 退回后停留 collected：不切 Tab；选中落到下一条同组行，无剩余则清空回空态。
      const collectedOrder = entries.filter(
        (e) => !e.archived && isPendingCollectedStatus(e.status),
      );
      const idx = collectedOrder.findIndex((e) => e.id === id);
      const remaining = collectedOrder.filter((e) => e.id !== id);
      const next =
        remaining.length === 0
          ? null
          : (remaining[Math.min(Math.max(idx, 0), remaining.length - 1)] ?? remaining[0] ?? null);
      setSelectedId(next ? next.id : null);
      setIsCreating(false);
      if (next) {
        setPrUrlInput(next.pr_url ?? '');
        loadIntoForm(next.item);
      } else {
        setPrUrlInput('');
        setFormErrors({});
      }
      setBatchSelected((prev) => {
        if (!prev.has(id)) return prev;
        const nextSet = new Set(prev);
        nextSet.delete(id);
        return nextSet;
      });
      onNotify?.(t('pending.reverted', { id, defaultValue: `已退回草稿：${id}` }), 'info');
    } catch (e) {
      onNotify?.(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRevertingId(null);
      setConfirmRevertId(null);
    }
  };

  /**
   * 标记为未提交（submitted → collected，pr_url 清空）：二次确认复用删除/退回形态；
   * 成功后行离开已提交、回到待提交（父级刷新后），Issue 需用户在 GitHub 自行关闭。
   * 已归档/非 submitted 行拒绝；无回调不渲染该动作（预览模式无后端写入）。
   */
  const handleWithdrawSubmitted = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || withdrawingId === id) return;
    if (target.archived || target.status !== 'submitted') return;
    if (!onWithdrawSubmitted) return;
    if (confirmWithdrawId !== id) {
      setConfirmWithdrawId(id);
      window.setTimeout(() => {
        setConfirmWithdrawId((prev) => (prev === id ? null : prev));
      }, 4000);
      return;
    }
    setWithdrawingId(id);
    try {
      await onWithdrawSubmitted(id);
      // 撤下后行离开已提交：选中清空（父级刷新后回待提交分段），批量重新可选。
      setSelectedId(null);
      setIsCreating(false);
      setPrUrlInput('');
      setFormErrors({});
      setBatchSelected((prev) => {
        if (!prev.has(id)) return prev;
        const nextSet = new Set(prev);
        nextSet.delete(id);
        return nextSet;
      });
      onNotify?.(t('pending.withdrawn', { id }), 'success');
    } catch (e) {
      onNotify?.(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setWithdrawingId(null);
      setConfirmWithdrawId(null);
    }
  };

  /**
   * 收录进本地：收录档校验通过后 status=collected（首页/分类同展，可搜可装）；
   * 已提交行前端硬拦（直接 toast，不调后端，避免重复收录）；
   * 已收录行仅提示已收录，不重复调后端；
   * 缺项可点击：置内联 + 定位首错，不 toast；后端失败 toast 原文。
   */
  const handleCollectLocal = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || collectingId === id) return;
    if (target.archived) return;
    if (target.status === 'submitted') {
      onNotify?.(
        t('pending.errors.already_submitted', { id, defaultValue: `已提交行不可重复提交：${id}` }),
        'warning',
      );
      return;
    }
    if (isPendingCollectedStatus(target.status)) {
      onNotify?.(t('pending.already_collected', { id, defaultValue: `已收录进本地：${id}` }), 'info');
      return;
    }
    const gate = await ensureLicenseGate();
    if (!gate) return;
    // 点击校验当前表单归一结果（可点：错即内联 + 定位首错，不 toast）
    const strictErrors = validatePendingDraft(collectFormItem(), 'submit', gate);
    if (Object.keys(strictErrors).length > 0) {
      setFormErrors(strictErrors);
      focusFirstError(strictErrors);
      return;
    }
    setCollectingId(id);
    try {
      if (onCollectLocal) {
        await onCollectLocal(id);
      } else {
        flipLocalCollected(id);
      }
      // 收录后切到本地收录 · 待提交，右侧切富卡 + 批量栏可见。
      setActiveGroup('library');
      setActiveSegment('to_submit');
      onNotify?.(t('pending.collected', { id, defaultValue: `已收录进本地：${id}` }), 'success');
    } catch (e) {
      onNotify?.(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setCollectingId(null);
    }
  };

  /**
   * 预填页打开（先直调 `tauriApi.openUrl` 成功即返，失败才原生 `window.open` 兜底）：
   * - 直调覆盖后端 `open_url`（rundll32 拉起默认浏览器），成功即返；
   * - 直调失败（非 Tauri / 后端 spawn 失败）才经 `resolveFallbackOpener()` 拿劫持前
   *   原生 opener 兜底（直接 `window.open` 会被劫持返回 null），返回 null（弹窗拦截/
   *   无原生）则抛错保留失败感知，杜绝全部打不开又不谎报成功。
   */
  const openPrefillPage = async (url: string): Promise<void> => {
    const trimmed = (url ?? '').trim();
    if (!trimmed) throw new Error('empty url');
    try {
      await tauriApi.openUrl(trimmed);
      return;
    } catch (directErr) {
      const opener = resolveFallbackOpener();
      if (opener) {
        try {
          const ret = opener(trimmed, '_blank', 'noopener,noreferrer');
          if (ret) return;
        } catch {
          /* 原生调用抛错则落到下方抛出来源错 */
        }
      }
      throw directErr;
    }
  };

  /**
   * 后端载荷复制：取后端产出的载荷文本并原样写入剪贴板（不 trim、不重新格式化）。
   * provider 缺席或取载荷/复制失败一律返回 false，由调用方走链接复制退化路径。
   */
  const copyBackendPayload = async (load: () => Promise<string>): Promise<boolean> => {
    try {
      const payload = await load();
      if (typeof payload !== 'string' || !payload.trim()) return false;
      return await copyTextToClipboard(payload);
    } catch {
      return false;
    }
  };

  /**
   * 预填页打开失败：真实 https 链接先复制到剪贴板再 toast（已复制链接，请手动打开）；
   * 复制失败或传入的非链接标识（invalid-URL 守卫传 id）只报 plain open_failed，不谎报已复制。
   */
  const notifyPrefillOpenFailed = async (url: string, err: unknown): Promise<void> => {
    const message = err instanceof Error ? err.message : String(err);
    const target = (url ?? '').trim();
    const copied = /^https:\/\//i.test(target) ? await copyTextToClipboard(target) : false;
    if (copied) {
      onNotify?.(
        t('pending.pr.open_failed_copied', {
          message,
          defaultValue: `预填页打开失败：${message}；已复制链接，请手动打开`,
        }),
        'error',
      );
      return;
    }
    onNotify?.(
      t('pending.pr.open_failed', { message, defaultValue: `预填页打开失败：${message}` }),
      'error',
    );
  };

  /**
   * 单卡“提交 Issue”：仅收录态可提交（draft 先收录进本地）→ 先确保后端许可名单就绪
   * （失败提示重试并中止，不回退本地名单）→ 提交档本地预检（与后端 SubmitStrict 同口径；
   * 缺项可点击：置内联 + 定位首错，不 toast）→ 取预填 URL（后端产出；无 provider 即预览模式，
   * 硬拦提示去桌面版）→ 打开预填 URL（无 token 纯 URL）即止：不自动 mark submitted，
   * 用户在预填页提交 Issue 后回本地收录手动贴链接确认（复用 mark_submitted 行），
   * 取消则停留 collected，可重新提交。
   * 超长（> PREFILL_URL_LENGTH_LIMIT）：优先复制后端产出的载荷 JSON（前端不拼装/格式化），
   * 复制不到才提示分批并复制链接；两种情形都仍尝试打开预填页。
   * 打开失败：复制预填链接并 toast 已复制（复制不到只报打开失败），不谎报成功。
   */
  const handleSubmitPr = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || submittingId === id) return;
    if (target.archived) return;
    if (!isPendingCollectedStatus(target.status)) {
      onNotify?.(t('pending.need_local_hint', { id }), 'warning');
      return;
    }
    const gate = await ensureLicenseGate();
    if (!gate) return;
    // 点击校验当前表单归一结果（可点：错即内联 + 定位首错，不 toast）
    const strictErrors = validatePendingDraft(collectFormItem(), 'submit', gate);
    if (Object.keys(strictErrors).length > 0) {
      setFormErrors(strictErrors);
      focusFirstError(strictErrors);
      return;
    }
    setSubmittingId(id);
    try {
      // 先取 URL：后端门禁错直接透出 toast，中止不开页；无回调即预览模式不可提交。
      if (!onGetPrUrl) {
        onNotify?.(
          t('pending.pr.preview_only', {
            defaultValue: '预览模式仅演示，提交 Issue 请在桌面版完成',
          }),
          'warning',
        );
        return;
      }
      let url = '';
      try {
        url = await onGetPrUrl(id);
      } catch (e) {
        onNotify?.(e instanceof Error ? e.message : String(e), 'error');
        return;
      }
      // 合法 https 预填必过：trim + 大小写不敏感判 https，避免首尾空白/大小写误杀；
      // 空值/非 https 仍 fail-closed（不尝试打开，直接失败感知）。
      const trimmedUrl = (url ?? '').trim();
      if (!trimmedUrl || !/^https:\/\//i.test(trimmedUrl)) {
        await notifyPrefillOpenFailed(trimmedUrl || target.id, new Error('invalid prefill url'));
        return;
      }
      url = trimmedUrl;
      // 预填链接长度判定（含 percent-encoding 膨胀，按编码后 URL 全长计，与 Spec §5 对齐）。
      if (url.length > PREFILL_URL_LENGTH_LIMIT) {
        const payloadCopied = onGetPrPayload
          ? await copyBackendPayload(() => onGetPrPayload(id))
          : false;
        if (payloadCopied) {
          onNotify?.(
            t('pending.pr.payload_copied', {
              length: url.length,
              defaultValue: `预填链接过长（${url.length} 字符），已复制提交载荷，正在打开预填页`,
            }),
            'success',
          );
        } else {
          onNotify?.(
            t('pending.pr.url_too_long', {
              length: url.length,
              defaultValue: `预填链接过长（${url.length} 字符），建议分批提交`,
            }),
            'warning',
          );
          if (await copyTextToClipboard(url)) {
            onNotify?.(
              t('pending.pr.url_copied_open_hint', {
                defaultValue: '已复制预填链接，可直接粘贴到浏览器打开',
              }),
              'info',
            );
          }
        }
      }
      try {
        await openPrefillPage(url);
      } catch (e) {
        await notifyPrefillOpenFailed(url, e);
        return;
      }
      // 打开预填页后即止：不 mark submitted、不切分组，停留 collected 等手动确认。
    } finally {
      setSubmittingId(null);
    }
  };

  /** 二期批量候选：仅已收录未归档（collected 系；draft 先收录进本地，已提交/已归档不再进批）。 */
  const batchCandidates = useMemo(
    () => entries.filter((e) => !e.archived && isPendingCollectedStatus(e.status)),
    [entries],
  );

  // 提交态/归档态一旦离开候选（父级刷新或本地翻态），立即从批量选中剔除，保证 submitted 永不入批。
  useEffect(() => {
    setBatchSelected((prev) => {
      if (prev.size === 0) return prev;
      const candidateIds = new Set(batchCandidates.map((e) => e.id));
      const next = new Set<string>();
      for (const id of prev) if (candidateIds.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [batchCandidates]);

  /** 列表多选可用性：仅本地收录 · 非已提交分段可勾选；行本身仍限 collected 系（submitted/draft/archived 不可选）。 */
  const isBatchSelectableGroup = activeGroup === 'library' && activeSegment !== 'submitted';
  const showBatchSelection = showBatchBar && isBatchSelectableGroup;

  const toggleBatchSelected = (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || target.archived || !isPendingCollectedStatus(target.status)) return;
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

  // 批量选中项的 submit 档 live 拦阻（快照口径，不每键 IPC；未就绪按 disabled 暂不标 license）。
  const batchPicked = useMemo(
    () => batchCandidates.filter((e) => batchSelected.has(e.id)),
    [batchCandidates, batchSelected],
  );
  const batchBlockedLive = useMemo(
    () =>
      batchPicked.filter(
        (e) => Object.keys(validatePendingDraft(e.item, 'submit', effectiveGate)).length > 0,
      ),
    [batchPicked, effectiveGate],
  );
  const hasBatchErrors = batchBlockedLive.length > 0;
  const batchLicenseErrorId = useMemo(() => {
    for (const e of batchBlockedLive) {
      if (validatePendingDraft(e.item, 'submit', effectiveGate).license) return e.id;
    }
    return null;
  }, [batchBlockedLive, effectiveGate]);

  /**
   * 批量提交（仅本地收录分组：列表多选 + 列表工具行按钮，随切 Tab 显隐）：先确保后端许可名单就绪（失败提示重试并中止）→
   * 选中多条 → 提交档本地预检（缺项可点击：拦阻行内列出 ids，不 toast 不开页不标记）→
   * 取批量预填 URL（后端产出；无 provider 即预览模式，硬拦提示去桌面版）→
   * 一个预填 URL（批量合一）即止：不自动 mark，
   * 各条目 submitted 态靠用户逐条手动贴链接确认，取消则停留 collected 可重新提交。
   * 超长（> PREFILL_URL_LENGTH_LIMIT）：优先复制后端产出的批量载荷 JSON 数组
   * （前端不拼装/格式化），复制不到才提示分批并复制链接；两种情形都仍尝试打开预填页。
   * 打开失败：复制预填链接并 toast 已复制（复制不到只报打开失败），不谎报 batch_submitted；
   * 仅打开成功才清选中 + 报 batch_submitted。showBatchBar=false 时隐藏工具行入口与多选。
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
      setFormErrors(validatePendingDraft(blocked[0].item, 'submit', gate));
      scrollToBatchBlocked();
      return;
    }
    setBatchBusy(true);
    try {
      const ids = picked.map((e) => e.id);
      // 先取 URL：后端门禁错直接透出 toast，中止不开页；无回调即预览模式不可提交。
      if (!onGetBatchPrUrl) {
        onNotify?.(
          t('pending.pr.preview_only', {
            defaultValue: '预览模式仅演示，提交 Issue 请在桌面版完成',
          }),
          'warning',
        );
        return;
      }
      let url = '';
      try {
        url = await onGetBatchPrUrl(ids);
      } catch (e) {
        onNotify?.(e instanceof Error ? e.message : String(e), 'error');
        return;
      }
      const trimmedBatchUrl = (url ?? '').trim();
      if (!trimmedBatchUrl || !/^https:\/\//i.test(trimmedBatchUrl)) {
        await notifyPrefillOpenFailed(ids.join('、') || 'batch', new Error('invalid prefill url'));
        return;
      }
      url = trimmedBatchUrl;
      // 预填链接长度判定（含 percent-encoding 膨胀，按编码后 URL 全长计，与 Spec §5 对齐）。
      if (url.length > PREFILL_URL_LENGTH_LIMIT) {
        const payloadCopied = onGetBatchPrPayload
          ? await copyBackendPayload(() => onGetBatchPrPayload(ids))
          : false;
        if (payloadCopied) {
          onNotify?.(
            t('pending.pr.payload_copied', {
              length: url.length,
              defaultValue: `预填链接过长（${url.length} 字符），已复制提交载荷，正在打开预填页`,
            }),
            'success',
          );
        } else {
          onNotify?.(
            t('pending.pr.url_too_long', {
              length: url.length,
              count: ids.length,
              defaultValue: `预填链接过长（${url.length} 字符），建议分批提交`,
            }),
            'warning',
          );
          if (await copyTextToClipboard(url)) {
            onNotify?.(
              t('pending.pr.url_copied_open_hint', {
                defaultValue: '已复制预填链接，可直接粘贴到浏览器打开',
              }),
              'info',
            );
          }
        }
      }
      try {
        await openPrefillPage(url);
      } catch (e) {
        await notifyPrefillOpenFailed(url, e);
        return;
      }
      // 打开预填页后即止：不逐条 mark submitted，停留 collected 等手动确认。
      setBatchSelected(new Set());
      onNotify?.(t('pending.pr.batch_submitted', { count: ids.length }), 'success');
    } finally {
      setBatchBusy(false);
    }
  };

  const showEditor = isCreating || editingEntry !== null;
  const isArchived = Boolean(editingEntry?.archived);
  // 富卡分支：后链路（collected/submitted/archived，非新建）一律富卡展示，不再出现新建式表单页；
  // 仅 draft（含新建）走表单。archived 富卡只读 + 复制为新草稿。
  const isRichCollectedView =
    !isCreating &&
    editingEntry !== null &&
    entryGroup(editingEntry) !== 'draft';
  const richCardApp = useMemo(() => {
    if (!editingEntry) return null;
    return pendingDraftToAppSummary(editingEntry.item, editingEntry.status, editingEntry.archived);
  }, [editingEntry]);
  // 富卡态内联口径：live（快照）与提交尝试（formErrors，真实门禁）合并展示，
  // 门禁未就绪时 live 按 disabled 暂不标，提交后以 formErrors 为准。
  const richInlineErrors: PendingDraftErrors = useMemo(() => {
    if (!isRichCollectedView) return {};
    // 已归档只读不做提交拦阻，不展内联错误。
    if (editingEntry?.archived) return {};
    return { ...liveSubmitErrors, ...formErrors };
  }, [isRichCollectedView, liveSubmitErrors, formErrors, editingEntry]);
  const expectedId = form.owner.trim() && form.repo.trim() ? canonicalDraftId(form.owner, form.repo) : '';
  const currentId = form.id.trim() || expectedId;

  return (
    <ViewShell viewClass="pending-view">
      {/* 1. 页头：仅标题 + 描述（无计数徽标；草稿/收录计数由 Tab 自带；页头不再设新建入口，新建走空态提示） */}
      <div className="pending-header">
        <div className="pending-header-info">
          <h3 className="pending-header-title">
            <Inbox size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>{t('pending.title')}</span>
          </h3>
          <p className="pending-header-desc">
            {t('pending.subtitle')}
          </p>
        </div>
      </div>

      {/* 2. 状态 tabs 分组（草稿 / 本地收录 / 已归档） */}
      <div className="segmented-group" role="tablist" aria-label={t('pending.title')} style={{ marginBottom: '12px' }}>
        {GROUP_META.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeGroup === id}
            className={`segmented-item ${activeGroup === id ? 'active' : ''}`}
            onClick={() => handleGroupChange(id)}
          >
            <Icon size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{t(`pending.groups.${id}`)}</span>
            <span className="segmented-count">{counts[id]}</span>
          </button>
        ))}
      </div>

      {/* 2b. 本地收录内部分段：全部 / 待提交 / 已提交（内层过滤，非第二层导航；其他 Tab 不展） */}
      {activeGroup === 'library' && (
        <div
          className="pending-segment-row"
          role="group"
          aria-label={t('pending.groups.library')}
        >
          {SEGMENT_META.map(({ id }) => (
            <button
              key={id}
              type="button"
              data-testid={`pending-segment-${id}`}
              aria-pressed={activeSegment === id}
              className={`pending-segment ${activeSegment === id ? 'active' : ''}`}
              onClick={() => handleSegmentChange(id)}
            >
              <span>{t(`pending.segments.${id}`)}</span>
              <span className="pending-segment-count">{segmentCounts[id]}</span>
            </button>
          ))}
        </div>
      )}

      {/* 3. 批量拦阻行内提示（仅本地收录分组随多选展出；复用同文案/testid） */}
      {showBatchSelection && hasBatchErrors && batchPicked.length > 0 && (
        <div
          data-testid="pending-batch-blocked"
          style={{ ...errorStyle, margin: '0 0 12px' }}
        >
          {t('pending.pr.batch_blocked', {
            ids: batchBlockedLive.map((e) => e.id).join('、'),
          })}
        </div>
      )}

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
                <div style={{ fontWeight: 510, color: 'var(--text-secondary)' }}>
                  {activeGroup === 'library'
                    ? t(`pending.segments.empty_title.${activeSegment}`)
                    : t('pending.group_empty_title')}
                </div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
                  {activeGroup === 'library'
                    ? t(`pending.segments.empty_desc.${activeSegment}`)
                    : t('pending.group_empty_desc')}
                </div>
              </div>
            ) : (
              visibleEntries.map((entry) => {
                const selected = entry.id === selectedId;
                const group = entryGroup(entry);
                const isSubmitted = isSubmittedEntry(entry);
                const isArchived = group === 'archived';
                const isCollected = !isArchived && !isSubmitted && isPendingCollectedStatus(entry.status);
                const batchChecked = batchSelected.has(entry.id);
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
                    {showBatchSelection && isCollected && (
                      <input
                        type="checkbox"
                        checked={batchChecked}
                        onChange={() => toggleBatchSelected(entry.id)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        aria-label={entry.id}
                        title={t('pending.pr.batch_selected', { count: batchSelected.size, defaultValue: `已选 ${batchSelected.size}` })}
                        style={{ flexShrink: 0 }}
                      />
                    )}
                    <span className="pending-item-icon-box">
                      {isArchived ? (
                        <Archive size={14} strokeWidth={1.5} aria-hidden="true" />
                      ) : isSubmitted ? (
                        <Send size={14} strokeWidth={1.5} aria-hidden="true" />
                      ) : isCollected ? (
                        <PackageCheck size={14} strokeWidth={1.5} aria-hidden="true" />
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
            {/* 列表底部工具行：批量提交专属位置（随本地收录 · 非已提交分段显隐，多选汇总/禁用/title 逻辑不变，右对齐单色） */}
            {showBatchSelection && (
              <div
                className="pending-list-toolbar"
                data-testid="pending-batch-toolbar"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: '8px', minHeight: '28px' }}
              >
                <button
                  type="button"
                  className="btn-fluent btn-primary btn-sm"
                  data-testid="pending-batch-submit"
                  disabled={batchBusy || batchPicked.length === 0}
                  onClick={() => void handleBatchSubmit()}
                  title={
                    hasBatchErrors
                      ? batchLicenseErrorId
                        ? t('pending.pr.license_fix_hint', { id: batchLicenseErrorId })
                        : t('pending.fix_errors')
                      : undefined
                  }
                >
                  <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                  <span>
                    {batchBusy
                      ? t('pending.pr.batch_submitting')
                      : t('pending.pr.batch_submit', { count: batchPicked.length })}
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* 右：Detail（draft 表单 / 后链路富卡：collected/submitted/archived 一律富卡） */}
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
            ) : isRichCollectedView && editingEntry && richCardApp ? (
              <>
                <div className="app-card pending-editor-card">
                  {/* 富卡头：标题 + 分组徽标（无坐标显隐开关，富卡即全量） */}
                  <div className="pending-editor-header">
                    <div className="pending-editor-title-wrap">
                      {editingEntry.archived ? (
                        <Archive size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                      ) : isSubmittedEntry(editingEntry) ? (
                        <Send size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                      ) : (
                        <PackageCheck size={15} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                      )}
                      <strong
                        className="pending-editor-title"
                        title={editingEntry.id}
                      >
                        {editingEntry.id}
                      </strong>
                      {editingEntry.archived ? (
                        <span className="nav-badge" title={t('pending.archived_badge')}>
                          {t('pending.archived_badge')}
                        </span>
                      ) : isSubmittedEntry(editingEntry) ? (
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
                      app={richCardApp}
                      isInstalled={false}
                      isManaged={false}
                      platformLoading={false}
                      onOpenDetail={() => {}}
                      onQuickInstall={() => {}}
                    />
                  </div>

                  {/* 富卡内联拦阻（与表单同 testid 口径，提交/收录前缺项即显） */}
                  {Object.keys(richInlineErrors).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                      {(Object.entries(richInlineErrors) as Array<[string, string | undefined]>).map(([key, code]) =>
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
                      {onWithdrawSubmitted && isSubmittedEntry(editingEntry) && (
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
                          data-testid="pending-withdraw-submitted"
                          disabled={withdrawingId === editingEntry.id}
                          onClick={() => void handleWithdrawSubmitted(editingEntry.id)}
                          title={t('pending.withdraw_hint', { id: editingEntry.id })}
                        >
                          <Undo2 size={13} strokeWidth={1.5} aria-hidden="true" />
                          <span>
                            {withdrawingId === editingEntry.id
                              ? t('pending.withdrawing')
                              : confirmWithdrawId === editingEntry.id
                                ? t('pending.confirm_withdraw')
                                : t('pending.withdraw_submitted')}
                          </span>
                        </button>
                      )}
                      {!editingEntry.archived && isSubmittedEntry(editingEntry) && (
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
                          data-testid="pending-delete"
                          onClick={() => void handleDelete(editingEntry.id)}
                          title={t('pending.delete_hint')}
                          style={{ marginLeft: 'auto' }}
                        >
                          <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
                          <span>
                            {confirmDeleteId === editingEntry.id ? t('pending.confirm_delete') : t('pending.delete')}
                          </span>
                        </button>
                      )}
                      {!editingEntry.archived && isPendingCollectedStatus(editingEntry.status) && (
                        <>
                          <button
                            type="button"
                            className="btn-fluent btn-secondary btn-sm"
                            data-testid="pending-revert-to-draft"
                            disabled={revertingId === editingEntry.id}
                            onClick={() => void handleRevertToDraft(editingEntry.id)}
                            title={t('pending.revert_hint', { id: editingEntry.id, defaultValue: '将本地收录退回草稿' })}
                            style={{ marginLeft: 'auto' }}
                          >
                            <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
                            <span>
                              {confirmRevertId === editingEntry.id
                                ? t('pending.confirm_revert', { defaultValue: '再次点击确认退回' })
                                : t('pending.revert_to_draft', { defaultValue: '退回草稿' })}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="btn-fluent btn-primary btn-sm"
                            data-testid="pending-submit-pr"
                            disabled={submittingId === editingEntry.id}
                            onClick={() => void handleSubmitPr(editingEntry.id)}
                            title={
                              hasSubmitErrors
                                ? hasLicenseSubmitError
                                  ? t('pending.pr.license_fix_hint', { id: editingEntry.id })
                                  : t('pending.fix_errors')
                                : t('pending.pr.prefill_hint')
                            }
                          >
                            <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                            <span>
                              {submittingId === editingEntry.id
                                ? t('pending.pr.submitting')
                                : t('pending.pr.submit_pr')}
                            </span>
                          </button>
                        </>
                      )}
                    </div>

                    {/* 已提交展 Issue 链接 + 删除（不再重复提交）；已收录才展手动标记行；已归档只读 */}
                    {!editingEntry.archived && isPendingCollectedStatus(editingEntry.status) && (
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
                    {!editingEntry.archived && editingEntry.status === 'submitted' && editingEntry.pr_url && (
                      <div className="pending-editor-footer-manual">
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
                      </div>
                    )}
                    {editingEntry.archived && (
                      <div className="pending-editor-footer-manual">
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
                        <div className="pending-manual-row">
                          <span className="pending-archived-hint">
                            已归档草稿为只读，改名或修改请使用“复制为新草稿”
                          </span>
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
                      </div>
                    )}
                  </div>
                </div>
              </>
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

                      {/* 描述：按当前语言取 description/description_en，空回退另一语言，两空复用 trends.no_desc */}
                      {(() => {
                        const previewDesc = resolvePendingDraftDescription(form, i18n.language);
                        return (
                          <p className={`pending-preview-desc ${!previewDesc ? 'pending-preview-empty' : ''}`}>
                            {previewDesc || t('trends.no_desc')}
                          </p>
                        );
                      })()}

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
                    {!isCreating && editingEntry && isSubmittedEntry(editingEntry) && (
                      <span className="nav-badge" style={{ color: 'var(--brand-primary)', borderColor: 'var(--brand-glow)' }}>
                        {t('pending.segments.submitted')}
                      </span>
                    )}
                    {!isCreating && editingEntry && !editingEntry.archived && isPendingCollectedStatus(editingEntry.status) && editingEntry.status !== 'submitted' && (
                      <span className="nav-badge" title={t('pending.groups.library')}>
                        {t('pending.groups.library')}
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
                        onBlur={handleFieldBlur}
                        placeholder="rustdesk"
                        autoComplete="off"
                        readOnly={!isCreating || isArchived}
                      />
                      {formErrors.owner && (
                        <em data-testid="pending-error-owner" style={errorStyle}>
                          {errorText(formErrors.owner)}
                        </em>
                      )}
                    </label>

                    <label style={labelStyle}>
                      <span>{t('pending.fields.repo')}</span>
                      <input
                        className="input-fluent"
                        value={form.repo}
                        onChange={(e) => setField('repo', e.target.value)}
                        onBlur={handleFieldBlur}
                        placeholder="rustdesk"
                        autoComplete="off"
                        readOnly={!isCreating || isArchived}
                      />
                      {formErrors.repo && (
                        <em data-testid="pending-error-repo" style={errorStyle}>
                          {errorText(formErrors.repo)}
                        </em>
                      )}
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
                      {isCreating ? (
                        <input
                          className="input-fluent"
                          data-testid="pending-id-input"
                          value={form.id}
                          onChange={(e) => setField('id', e.target.value)}
                          onBlur={() => {
                            handleIdBlur();
                            handleFieldBlur();
                          }}
                          placeholder="owner/repo"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      ) : (
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
                      )}
                      {isCreating && expectedId && (
                        <span style={hintStyle}>
                          {t('pending.id_preview', { id: expectedId })}
                        </span>
                      )}
                      {formErrors.id && (
                        <em data-testid="pending-error-id" style={errorStyle}>
                          {errorText(formErrors.id)}
                        </em>
                      )}
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
                    onBlur={handleFieldBlur}
                    placeholder={t('pending.placeholders.name')}
                    readOnly={isArchived}
                  />
                  {formErrors.name && (
                    <em data-testid="pending-error-name" style={errorStyle}>
                      {errorText(formErrors.name)}
                    </em>
                  )}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.description')}</span>
                  <textarea
                    className="input-fluent"
                    value={form.description}
                    onChange={(e) => setField('description', e.target.value)}
                    onBlur={handleFieldBlur}
                    rows={2}
                    placeholder={t('pending.placeholders.description')}
                    readOnly={isArchived}
                  />
                  {formErrors.description && (
                    <em data-testid="pending-error-description" style={errorStyle}>
                      {errorText(formErrors.description)}
                    </em>
                  )}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.category')}</span>
                  <input
                    className="input-fluent"
                    value={form.category}
                    onChange={(e) => setField('category', e.target.value)}
                    onBlur={handleFieldBlur}
                    placeholder="dev"
                    autoComplete="off"
                    readOnly={isArchived}
                  />
                  {formErrors.category && (
                    <em data-testid="pending-error-category" style={errorStyle}>
                      {errorText(formErrors.category)}
                    </em>
                  )}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.license')}</span>
                  <input
                    className="input-fluent"
                    value={form.license}
                    onChange={(e) => setField('license', e.target.value)}
                    onBlur={handleFieldBlur}
                    placeholder="MIT"
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                  {formErrors.license && (
                    <em data-testid="pending-error-license" style={errorStyle}>
                      {errorText(formErrors.license)}
                    </em>
                  )}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.homepage')}</span>
                  <input
                    className="input-fluent"
                    value={form.homepage}
                    onChange={(e) => setField('homepage', e.target.value)}
                    onBlur={handleFieldBlur}
                    placeholder="https://example.com"
                    inputMode="url"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                  {formErrors.homepage && (
                    <em data-testid="pending-error-homepage" style={errorStyle}>
                      {errorText(formErrors.homepage)}
                    </em>
                  )}
                </label>

                <label style={labelStyle}>
                  <span>{t('pending.fields.default_version')}</span>
                  <input
                    className="input-fluent"
                    value={form.default_version}
                    onChange={(e) => setField('default_version', e.target.value)}
                    onBlur={handleFieldBlur}
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
                  onClick={() => toggleSection('supplemental')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleSection('supplemental');
                    }
                  }}
                >
                  <div className="pending-section-title-wrap">
                    <AlignLeft size={13} strokeWidth={1.5} aria-hidden="true" />
                    <span>补充信息（可选）</span>
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
                    onChange={(e) => setField('category_name', e.target.value)}
                    onBlur={handleFieldBlur}
                    placeholder={t('pending.placeholders.category_name')}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.supplemental ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.description_en')}</span>
                  <textarea
                    className="input-fluent"
                    value={form.description_en}
                    onChange={(e) => setField('description_en', e.target.value)}
                    onBlur={handleFieldBlur}
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
                    onChange={(e) => setField('icon', e.target.value)}
                    onBlur={handleFieldBlur}
                    placeholder="https://…"
                    inputMode="url"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.supplemental ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.aliases')}</span>
                  <input
                    className="input-fluent"
                    value={aliasesText}
                    onChange={(e) => handleTextFieldChange('aliases', e.target.value)}
                    onBlur={handleFieldBlur}
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
                    <span>运行时（高级）</span>
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
                    className="input-fluent"
                    value={platformsText}
                    onChange={(e) => handleTextFieldChange('platforms', e.target.value)}
                    onBlur={handleFieldBlur}
                    placeholder="windows, linux"
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={isArchived}
                  />
                </label>

                <label style={{ ...labelStyle, display: openSections.runtime ? 'flex' : 'none' }}>
                  <span>{t('pending.fields.identifiers')}</span>
                  <textarea
                    className="input-fluent"
                    value={identifiersText}
                    onChange={(e) => handleTextFieldChange('identifiers', e.target.value)}
                    onBlur={handleFieldBlur}
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
                    {!isCreating && editingEntry && !isArchived && editingEntry.status === 'draft' && (
                      <button
                        type="button"
                        className="btn-fluent btn-primary btn-sm"
                        data-testid="pending-collect-local"
                        disabled={collectingId === editingEntry.id}
                        onClick={() => void handleCollectLocal(editingEntry.id)}
                        title={
                          hasSubmitErrors
                            ? hasLicenseSubmitError
                              ? t('pending.pr.license_fix_hint', { id: editingEntry.id })
                              : t('pending.fix_errors')
                            : t('pending.need_local_hint', { id: editingEntry.id })
                        }
                        style={{ marginLeft: 'auto' }}
                      >
                        <Inbox size={13} strokeWidth={1.5} aria-hidden="true" />
                        <span>
                          {collectingId === editingEntry.id
                            ? t('pending.collecting', { defaultValue: '收录中…' })
                            : t('pending.collect_local')}
                        </span>
                      </button>
                    )}
                    {!isCreating && editingEntry && !isArchived && isPendingCollectedStatus(editingEntry.status) && (
                      <>
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
                          data-testid="pending-revert-to-draft"
                          disabled={revertingId === editingEntry.id}
                          onClick={() => void handleRevertToDraft(editingEntry.id)}
                          title={t('pending.revert_hint', { id: editingEntry.id, defaultValue: '将本地收录退回草稿' })}
                          style={{ marginLeft: 'auto' }}
                        >
                          <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
                          <span>
                            {confirmRevertId === editingEntry.id
                              ? t('pending.confirm_revert', { defaultValue: '再次点击确认退回' })
                              : t('pending.revert_to_draft', { defaultValue: '退回草稿' })}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn-fluent btn-primary btn-sm"
                          data-testid="pending-submit-pr"
                          disabled={submittingId === editingEntry.id}
                          onClick={() => void handleSubmitPr(editingEntry.id)}
                          title={
                            hasSubmitErrors
                              ? hasLicenseSubmitError
                                ? t('pending.pr.license_fix_hint', { id: editingEntry.id })
                                : t('pending.fix_errors')
                              : t('pending.pr.prefill_hint')
                          }
                        >
                          <Send size={13} strokeWidth={1.5} aria-hidden="true" />
                          <span>
                            {submittingId === editingEntry.id
                              ? t('pending.pr.submitting')
                              : t('pending.pr.submit_pr')}
                          </span>
                        </button>
                      </>
                    )}
                  </div>

                  {!isCreating && editingEntry && !isArchived && isPendingCollectedStatus(editingEntry.status) && (
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
