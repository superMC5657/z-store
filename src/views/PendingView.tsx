import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CountLabel } from '../components/CountBadge';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-pending.css';
import { Archive, FilePlus2, Inbox, PackageCheck, PencilLine, Send } from 'lucide-react';
import { FilterEmptyState, ViewShell, resolvePlatformReset } from './ViewShell';
import { PLATFORM_IDS, matchPlatformSet, type PlatformId } from '../lib/platformFilter';
import type { DraftItem } from '../services/custom';
import {
  getLicenseAllowlist,
  type LicenseAllowlistResult,
} from '../services/api/catalog';
import {
  getPendingSectionPrefs,
  setPendingSectionPrefs,
} from '../lib/pendingPrefs';
import {
  PENDING_EMPTY_DRAFT,
  PENDING_GROUP_ORDER,
  canonicalDraftId,
  entryGroup,
  isPendingCollectedStatus,
  parseIdentifiersText,
  pendingDraftToAppSummary,
  splitCsv,
  stringifyIdentifiers,
  validatePendingDraft,
  type CustomDraftEntry,
  type LicenseAllowlistInput,
  type PendingDraftErrors,
  type PendingGroupId,
} from './pending/draftModel';
import { runSubmitPrefillFlow } from './pending/submitPrefillFlow';
import type { ShowToast } from '../types';
import { PendingListColumn } from './pending/PendingListColumn';
import { PendingRichCard } from './pending/PendingRichCard';
import { PendingPreviewLane } from './pending/PendingPreviewLane';
import { PendingDraftForm } from './pending/PendingDraftForm';

/** 待收录页（UI 层，自维护草稿 overlay 前端）。
 *
 * - 本组件只管编排（状态 + 处理器 + 布局骨架），表单段/列表/富卡/预览各为
 *   `pending/` 子组件；不直调任何 Tauri 命令（许可名单经
 *   `services/api/catalog.getLicenseAllowlist` 封装调用，无字面量命令名直调，
 *   见 noDirectInvoke.test.ts；命令表驱动收敛于 CMD）。
 * - 许可名单唯一源头为后端只读命令：本文件不保留任何硬编码名单；
 *   暂存走 draft 档（不查名单），提交/预填 Issue 前拉取后端名单做 submit 档校验；
 *   加载失败放行暂存、提交提示重试。
 * - 受控/非受控双模：传入 `entries` 即为受控（直接透传后端列表），
 *   缺席时走内部本地态（浏览器预览/单测可独立渲染编辑）。
 * - 设计走 Linear 去彩单色：仅用文本层级 + 边框 + 单色图标，不引入彩色语义。
 * - 领域纯函数（校验/归一/分组）收容于 `pending/draftModel`，
 *   提交尾段收容于 `pending/submitPrefillFlow`。
 */

interface PendingViewProps {
  /** 受控草稿列表（缺席时走内部本地态）。 */
  entries?: CustomDraftEntry[];
  /** 初始草稿（非受控模式种子，故事/单测用）。 */
  initialEntries?: CustomDraftEntry[];
  /** 保存回调（缺席时仅更新本地态）。 */
  onSave?: (item: DraftItem) => void | Promise<void>;
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
   * 单条提交载荷（后端 `get_custom_app_pr_payload` 产出的 JSON 对象文本；
   * 前端只原样复制，不自行拼装/格式化）。预填链接超长时优先复制它。
   */
  onGetPrPayload?: (id: string) => Promise<string>;
  /**
   * 许可名单提供方（后端只读命令的前端封装；
   * 缺席时默认走 `getLicenseAllowlist`，单测可注入桩）。
   * 启动/提交前拉取，失败不回退写死名单（暂存放行、提交提示重试）。
   */
  onGetLicenseAllowlist?: () => Promise<LicenseAllowlistResult>;
  /** 轻提示通道（缺席时静默）。 */
  onNotify?: ShowToast;
  /** 全局设备平台筛选（缺席时视为全选，独立渲染/单测不受过滤）。 */
  selectedPlatforms?: ReadonlySet<string>;
  /** 「显示全部平台」重置（缺席时走广播兜底）。 */
  onResetPlatformFilter?: () => void;
  /** 向侧栏上报当前作用域（未归档 / 已归档）条目的平台分布。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number>) => void;
}

const ALL_PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_IDS);

/** 顶层四个互斥 Tab 的组图标（顺序见 PENDING_GROUP_ORDER）。 */
const GROUP_ICON: Record<PendingGroupId, typeof Inbox> = {
  draft: FilePlus2,
  to_submit: PackageCheck,
  submitted: Send,
  archived: Archive,
};

function emptyGroupCounts(): Record<PendingGroupId, number> {
  return { draft: 0, to_submit: 0, submitted: 0, archived: 0 };
}

function entryMatchesPlatforms(e: CustomDraftEntry, selected: ReadonlySet<string>): boolean {
  return matchPlatformSet({ platforms: [...(e.item.platforms ?? [])] }, selected);
}

/** 归一草稿表单与文本态字段（id 由非空 owner/repo 自动按小写派生，否则保留已有 id）。 */
function buildNormalizedFormItem(
  f: DraftItem,
  aliasesRaw: string,
  platformsRaw: string,
  identifiersRaw: string,
): DraftItem {
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
    aliases: splitCsv(aliasesRaw),
    platforms: splitCsv(platformsRaw.toLowerCase()),
    // 草稿即 catalog.json 单个应用 JSON：模板无 publishers/install_dirs/search_subdirs 时不出现，恒 []。
    publishers: [],
    install_dirs: [],
    search_subdirs: [],
    identifiers: parseIdentifiersText(identifiersRaw),
  };
}

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
  onGetPrPayload,
  onGetLicenseAllowlist,
  onNotify,
  selectedPlatforms = ALL_PLATFORMS,
  onResetPlatformFilter,
  onDisplayPlatformCounts,
}) => {
  const { t } = useTranslation();
  const [localEntries, setLocalEntries] = useState<CustomDraftEntry[]>(initialEntries);
  const entries = controlledEntries ?? localEntries;
  const [activeGroup, setActiveGroupState] = useState<PendingGroupId>('draft');
  // 智能默认落点只在首次拿到非空条目且用户/操作流尚未定过 Tab 时生效一次。
  const userPickedGroupRef = useRef(false);
  const didAutoSelectGroupRef = useRef(false);
  const setActiveGroup = useCallback((group: PendingGroupId) => {
    userPickedGroupRef.current = true;
    setActiveGroupState(group);
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [prUrlInput, setPrUrlInput] = useState('');
  const [formErrors, setFormErrors] = useState<PendingDraftErrors>({});
  // 单卡提交/收录忙态：提交中 id + 收录中 id（避免重复提交）。
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [confirmWithdrawId, setConfirmWithdrawId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(true);

  /**
   * 顶层四 Tab 切换（草稿 / 待提交 / 已提交 / 已归档）：
   * 右侧详情 + 操作按钮随 activeGroup 联动，
   * 切 Tab 即重置跨分组选中（含新建态与二次确认态），无选中走空态提示。
   */
  const handleGroupChange = (group: PendingGroupId) => {
    if (group === activeGroup) return;
    setActiveGroup(group);
    setSelectedId(null);
    setIsCreating(false);
    setConfirmDeleteId(null);
    setConfirmRevertId(null);
    setConfirmWithdrawId(null);
    setPrUrlInput('');
    setFormErrors({});
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
      onNotify?.(t('pending.pr.allowlist_load_failed'), 'warning');
    } else {
      setLicenseGateSnapshot(gate);
    }
    return gate;
  }, [loadLicenseGate, onNotify, t]);

  // 表单态（新建或选中行载入；identifier/platforms 等以文本态编辑，保存时归一）。
  const [form, setForm] = useState<DraftItem>(PENDING_EMPTY_DRAFT);
  const [aliasesText, setAliasesText] = useState('');
  const [platformsText, setPlatformsText] = useState('windows');
  const [identifiersText, setIdentifiersText] = useState('');

  // 逐框校验快照口径：已预取快照即用严格校验，未就绪按 disabled 暂不标 osi/gate（仍保留 required）。
  const effectiveGate: LicenseAllowlistInput = useMemo(
    () => licenseGateSnapshot ?? { enabled: false, allowed: [] },
    [licenseGateSnapshot],
  );

  // 当前表单归一后的 submit 档 live 校验（文本态字段归一后参验，不新增阻塞项）。
  const liveSubmitItem = useMemo(
    () => buildNormalizedFormItem(form, aliasesText, platformsText, identifiersText),
    [form, aliasesText, platformsText, identifiersText],
  );

  const liveSubmitErrors = useMemo(
    () => validatePendingDraft(liveSubmitItem, 'submit', effectiveGate),
    [liveSubmitItem, effectiveGate],
  );
  const hasSubmitErrors = Object.keys(liveSubmitErrors).length > 0;
  const hasLicenseSubmitError = Boolean(liveSubmitErrors.license);

  // rawCounts：不看平台筛选的分组条数（判定「被平台筛空」与兜底落点）；
  // counts：按全局设备平台筛选后的条数，即 Tab 角标，等于切入该 Tab 后左栏条目数。
  const { rawCounts, counts } = useMemo(() => {
    const raw = emptyGroupCounts();
    const filtered = emptyGroupCounts();
    for (const e of entries) {
      const g = entryGroup(e);
      raw[g] += 1;
      if (entryMatchesPlatforms(e, selectedPlatforms)) filtered[g] += 1;
    }
    return { rawCounts: raw, counts: filtered };
  }, [entries, selectedPlatforms]);

  const visibleEntries = useMemo(
    () =>
      entries.filter((e) => entryGroup(e) === activeGroup && entryMatchesPlatforms(e, selectedPlatforms)),
    [entries, activeGroup, selectedPlatforms],
  );

  // 首次拿到非空条目：当前 Tab 筛后为空则落到首个筛后非空 Tab（全空则首个原始非空 Tab，展示重置引导）。
  useEffect(() => {
    if (didAutoSelectGroupRef.current || userPickedGroupRef.current || isCreating) return;
    if (entries.length === 0) return;
    didAutoSelectGroupRef.current = true;
    if (counts[activeGroup] > 0) return;
    const target =
      PENDING_GROUP_ORDER.find((g) => counts[g] > 0) ?? PENDING_GROUP_ORDER.find((g) => rawCounts[g] > 0);
    if (target && target !== activeGroup) setActiveGroupState(target);
  }, [entries.length, counts, rawCounts, activeGroup, isCreating]);

  // 侧栏平台芯片：只统计当前 Tab 的条目（各 Tab 独立分布，不随平台勾选变化）。
  const displayPlatformCounts = useMemo<Record<PlatformId, number>>(() => {
    const out = {} as Record<PlatformId, number>;
    const groupEntries = entries.filter((e) => entryGroup(e) === activeGroup);
    for (const id of PLATFORM_IDS) {
      const singleton = new Set<string>([id]);
      out[id] = groupEntries.filter((e) => entryMatchesPlatforms(e, singleton)).length;
    }
    return out;
  }, [entries, activeGroup]);

  useReportPlatformCounts(displayPlatformCounts, onDisplayPlatformCounts);

  const previewPlatforms = useMemo(() => {
    return splitCsv(platformsText.toLowerCase());
  }, [platformsText]);

  const editingEntry = useMemo(() => {
    const found = entries.find((e) => e.id === selectedId) ?? null;
    // 跨 Tab 选中重置兜底：选中行不在当前 Tab 时视为无选中，走空态提示。
    // 平台筛选不参与判定：正在编辑的条目被筛出左栏时表单保持不丢失。
    if (found && !isCreating && entryGroup(found) !== activeGroup) return null;
    return found;
  }, [entries, selectedId, activeGroup, isCreating]);

  const loadIntoForm = (item: DraftItem) => {
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

  const setField = <K extends keyof DraftItem>(key: K, value: DraftItem[K]) => {
    const prev = form;
    const next = { ...prev, [key]: value };
    if (key === 'owner' || key === 'repo') {
      const owner = key === 'owner' ? String(value) : prev.owner;
      const repo = key === 'repo' ? String(value) : prev.repo;
      next.id = owner.trim() && repo.trim() ? canonicalDraftId(owner, repo) : '';
    }
    if (key === 'category') {
      const cat = String(value);
      if (cat) {
        next.category_name = t(`categories.cat_${cat}_name`, { defaultValue: cat });
      }
    }
    setForm(next);
    // 逐框即时校验：对归一后表单跑 submit 档（license 用快照，不每键 IPC）。
    const nextItem = buildNormalizedFormItem(next, aliasesText, platformsText, identifiersText);
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
    const nextItem = buildNormalizedFormItem(form, nextAliases, nextPlatforms, nextIdentifiers);
    setFormErrors(validatePendingDraft(nextItem, 'submit', effectiveGate));
  };

  // 通用失焦校验：对归一后表单跑 submit 档，合并进内联（不 toast）。
  const handleFieldBlur = () => {
    setFormErrors(validatePendingDraft(collectFormItem(), 'submit', effectiveGate));
  };

  const collectFormItem = (): DraftItem =>
    buildNormalizedFormItem(form, aliasesText, platformsText, identifiersText);

  // 首错定位：按表单顺序找首个错误 key，滚动到复用的 .pending-field-error 内联槽位并聚焦输入。
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

  const handleDuplicateDraft = () => {
    if (!editingEntry) return;
    // 复制为新草稿归 draft 分组：切回草稿 Tab 再展新建表单。
    setActiveGroup('draft');
    setIsCreating(true);
    setSelectedId(null);
    setConfirmDeleteId(null);
    setPrUrlInput('');
    const duplicatedItem: DraftItem = {
      ...editingEntry.item,
      id: '', // 清空 id，修改 owner/repo 时自动联动新 id
    };
    loadIntoForm(duplicatedItem);
    onNotify?.(
      t('pending.duplicated_hint'),
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
        t('pending.duplicate_conflict_hint', {
          id: item.id,
        }),
        'warning',
      );
      return;
    }
    if (onSave) {
      try {
        await onSave(item);
      } catch (e) {
        // 落盘失败：toast 报错并停留编辑态（表单内容保留可重试），成功后的出表单/选中/切组均不执行
        onNotify?.(
          t('pending.save_failed', {
            id: item.id,
            error: e instanceof Error ? e.message : String(e),
          }),
          'error',
        );
        return;
      }
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
      try {
        await onDelete(id);
      } catch (e) {
        // 删除失败：toast 报错并解除二次确认态（行保持原状），成功后的清选中不执行
        onNotify?.(
          t('pending.delete_failed', {
            id,
            error: e instanceof Error ? e.message : String(e),
          }),
          'error',
        );
        setConfirmDeleteId(null);
        return;
      }
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
      try {
        await onMarkSubmitted(id, url);
      } catch (e) {
        // 落盘失败：toast 报错并停留原分组（不切已提交），成功后的切换与提示均不执行
        onNotify?.(
          t('pending.mark_submitted_failed', {
            id,
            error: e instanceof Error ? e.message : String(e),
          }),
          'error',
        );
        return;
      }
    } else {
      flipLocalSubmitted(id, url);
    }
    // 手动标记后切到已提交：富卡仅展 Issue 链接，禁止重复提交。
    setActiveGroup('submitted');
    onNotify?.(t('pending.marked_submitted', { id }), 'success');
  };

  const flipLocalSubmitted = (id: string, url: string) => {
    setLocalEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'submitted' as const, pr_url: url } : e)),
    );
  };

  const flipLocalCollected = (id: string, item?: DraftItem) => {
    const now = Math.floor(Date.now() / 1000);
    setLocalEntries((prev) =>
      prev.map((e) =>
        e.id === id
          ? { ...e, ...(item ? { item, updated_at: now } : {}), status: 'collected' as const }
          : e,
      ),
    );
  };

  const flipLocalReverted = (id: string) => {
    setLocalEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'draft' as const } : e)),
    );
    setConfirmRevertId((prev) => (prev === id ? null : prev));
  };

  /**
   * 待提交退回草稿：二次确认复用删除确认形态（首点置确认态 4s，次点执行）；
   * 有回调走后端落盘（App 透传 revert，失败抛错 toast 不静默），缺席仅本地预览翻 draft 态；toast 复用现有风格。
   * 退回后停留待提交 Tab：选中清空或落到下一条同组行，由调用方切 Tab 回草稿查看。
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
      onNotify?.(t('pending.reverted', { id }), 'info');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      onNotify?.(
        t('pending.revert_failed', {
          id,
          error: detail,
        }),
        'error',
      );
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
      // 撤下后行离开已提交：选中清空（父级刷新后条目进入待提交 Tab）。
      setSelectedId(null);
      setIsCreating(false);
      setPrUrlInput('');
      setFormErrors({});
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
        t('pending.errors.already_submitted', { id }),
        'warning',
      );
      return;
    }
    if (isPendingCollectedStatus(target.status)) {
      onNotify?.(t('pending.already_collected', { id }), 'info');
      return;
    }
    const gate = await ensureLicenseGate();
    if (!gate) return;
    const item = collectFormItem();
    // 点击校验当前表单归一结果（可点：错即内联 + 定位首错，不 toast）
    const strictErrors = validatePendingDraft(item, 'submit', gate);
    if (Object.keys(strictErrors).length > 0) {
      setFormErrors(strictErrors);
      focusFirstError(strictErrors);
      return;
    }
    setCollectingId(id);
    try {
      // 收录前先把当前表单最新修改落盘。
      if (onSave) {
        await onSave(item);
      }
      if (onCollectLocal) {
        await onCollectLocal(id);
      }
      if (!controlledEntries) {
        flipLocalCollected(id, item);
      }
      loadIntoForm(item);
      // 收录后切到待提交，右侧切富卡。
      setActiveGroup('to_submit');
      onNotify?.(t('pending.collected', { id }), 'success');
    } catch (e) {
      onNotify?.(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setCollectingId(null);
    }
  };

  /**
   * 单卡“提交 Issue”：仅收录态可提交（draft 先收录进本地）→ 先确保后端许可名单就绪
   * （失败提示重试并中止，不回退本地名单）→ 提交档本地预检（与后端 SubmitStrict 同口径；
   * 缺项可点击：置内联 + 定位首错，不 toast）→ 共享提交尾段（取 URL→https 判→超长复制
   * 载荷→开页，见 pending/submitPrefillFlow）即止：不自动 mark submitted，
   * 用户在预填页提交 Issue 后回待提交手动贴链接确认（复用 mark_submitted 行），
   * 取消则停留 collected，可重新提交。
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
      await runSubmitPrefillFlow(
        { t, notify: (message, type) => onNotify?.(message, type) },
        {
          loadUrl: onGetPrUrl ? () => onGetPrUrl(id) : undefined,
          loadPayload: onGetPrPayload ? () => onGetPrPayload(id) : undefined,
          failLabel: target.id,
        },
      );
      // 打开预填页后即止：不 mark submitted、不切分组，停留 collected 等手动确认。
    } finally {
      setSubmittingId(null);
    }
  };

  const showEditor = isCreating || editingEntry !== null;
  // 富卡分支：collected/submitted/archived 非新建一律富卡展示，仅 draft（含新建）走表单。
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

  return (
    <ViewShell viewClass="pending-view">
      {/* 1. 页头：仅标题与描述（计数由各 Tab 自带，空态提示提供新建入口） */}
      <div className="pending-header">
        <div className="pending-header-info">
          <h3 className="pending-header-title">
            <Inbox size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>{t('pending.title')}</span>
          </h3>
          {t('pending.subtitle') ? (
            <p className="pending-header-desc">
              {t('pending.subtitle')}
            </p>
          ) : null}
        </div>
      </div>

      {/* 2. 四个互斥顶层 Tab（草稿 / 待提交 / 已提交 / 已归档），角标按全局平台筛选计数 */}
      <div className="segmented-group" role="tablist" aria-label={t('pending.title')} style={{ marginBottom: '12px' }}>
        {PENDING_GROUP_ORDER.map((id) => {
          const Icon = GROUP_ICON[id];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              data-testid={`pending-tab-${id}`}
              aria-selected={activeGroup === id}
              className={`segmented-item ${activeGroup === id ? 'active' : ''}`}
              onClick={() => handleGroupChange(id)}
            >
              <CountLabel
                icon={<Icon size={13} strokeWidth={1.5} aria-hidden="true" />}
                label={t(`pending.groups.${id}`)}
                count={counts[id]}
                active={activeGroup === id}
              />
            </button>
          );
        })}
      </div>

      {/* 3. 主区：草稿全空时展示全局引导；有草稿时展示 master-detail 左右分栏 */}
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
          <PendingListColumn
            entries={visibleEntries}
            selectedId={selectedId}
            onSelect={handleSelectEntry}
            activeGroup={activeGroup}
            hiddenByPlatformFilter={visibleEntries.length === 0 && rawCounts[activeGroup] > 0}
            onResetPlatformFilter={resolvePlatformReset(onResetPlatformFilter)}
          />

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
              <PendingRichCard
                entry={editingEntry}
                cardApp={richCardApp}
                inlineErrors={richInlineErrors}
                prUrlInput={prUrlInput}
                onPrUrlInput={setPrUrlInput}
                onMarkSubmitted={handleMarkSubmitted}
                submittingId={submittingId}
                onSubmitPr={(id) => void handleSubmitPr(id)}
                hasSubmitErrors={hasSubmitErrors}
                hasLicenseSubmitError={hasLicenseSubmitError}
                revertingId={revertingId}
                confirmRevertId={confirmRevertId}
                onRevertToDraft={(id) => void handleRevertToDraft(id)}
                withdrawingId={withdrawingId}
                confirmWithdrawId={confirmWithdrawId}
                onWithdrawSubmitted={
                  onWithdrawSubmitted ? (id) => void handleWithdrawSubmitted(id) : undefined
                }
                confirmDeleteId={confirmDeleteId}
                onDelete={(id) => void handleDelete(id)}
                onDuplicate={handleDuplicateDraft}
              />
            ) : (
              <>
                {/* 实时卡片预览窗口（Draft Visual / Post-inclusion preview lane） */}
                <PendingPreviewLane
                  form={form}
                  previewPlatforms={previewPlatforms}
                  expectedId={expectedId}
                  expanded={previewExpanded}
                  onToggle={() => setPreviewExpanded((prev) => !prev)}
                />

                <PendingDraftForm
                  form={form}
                  onField={setField}
                  onTextField={handleTextFieldChange}
                  onFieldBlur={handleFieldBlur}
                  formErrors={formErrors}
                  aliasesText={aliasesText}
                  platformsText={platformsText}
                  identifiersText={identifiersText}
                  isCreating={isCreating}
                  editing={editingEntry}
                  openSections={openSections}
                  onToggleSection={toggleSection}
                  onSave={handleSave}
                  confirmDeleteId={confirmDeleteId}
                  onDelete={handleDelete}
                  collectingId={collectingId}
                  onCollectLocal={(id) => void handleCollectLocal(id)}
                  hasSubmitErrors={hasSubmitErrors}
                  hasLicenseSubmitError={hasLicenseSubmitError}
                />
              </>
            )}
          </div>
        </div>
      )}
    </ViewShell>
  );
};
