import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CountLabel } from '../components/CountBadge';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-pending.css';
import { Archive, FilePlus2, Inbox, PackageCheck, PencilLine, Send } from 'lucide-react';
import { FilterEmptyState, ViewShell, resolvePlatformReset } from './ViewShell';
import { useAppContextProps, type AppContextProps } from '../app/AppContext';
import type { CustomAppsStore } from '../app/hooks/useCustomApps';
import { PLATFORM_IDS, matchPlatformSet, type PlatformId } from '../lib/platformFilter';
import type { LicenseAllowlistResult } from '../services/api/catalog';
import {
  getPendingSectionPrefs,
  setPendingSectionPrefs,
} from '../lib/pendingPrefs';
import {
  PENDING_EMPTY_DRAFT,
  PENDING_GROUP_ORDER,
  entryGroup,
  isPendingCollectedStatus,
  pendingDraftToAppSummary,
  type CustomDraftEntry,
  type PendingDraftErrors,
  type PendingGroupId,
} from './pending/draftModel';
import { runSubmitPrefillFlow } from './pending/submitPrefillFlow';
import { usePendingDraftEditor } from './pending/usePendingDraftEditor';
import type { ShowToast } from '../types';
import { PendingListColumn } from './pending/PendingListColumn';
import { PendingRichCard } from './pending/PendingRichCard';
import { PendingPreviewLane } from './pending/PendingPreviewLane';
import { PendingDraftForm } from './pending/PendingDraftForm';

/** 待收录页：协调草稿编辑、本地收录、Issue 提交与各分组 Tab；草稿状态与写入全部经 `useCustomApps`。 */

/** 视图依赖的草稿域接口（`useCustomApps` 返回值的子集）。 */
export type PendingCustomApps = Pick<
  CustomAppsStore,
  | 'customAppEntries'
  | 'handleSaveCustomApp'
  | 'handleDeleteCustomApp'
  | 'handleMarkCustomSubmitted'
  | 'handleCollectLocalApp'
  | 'handleRevertCollectedApp'
  | 'handleWithdrawSubmitted'
  | 'loadLicenseGate'
  | 'getPrUrl'
  | 'getPrPayload'
>;

interface PendingViewProps extends AppContextProps {
  customApps: PendingCustomApps;
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
const NO_ENTRIES: CustomDraftEntry[] = [];

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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const PendingView: React.FC<PendingViewProps> = (props) => {
  const {
    customApps,
    onNotify,
    selectedPlatforms = ALL_PLATFORMS,
    onResetPlatformFilter,
    onDisplayPlatformCounts,
  } = useAppContextProps(props);
  const { t } = useTranslation();
  const entries = customApps.customAppEntries ?? NO_ENTRIES;
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
  const [prUrlInput, setPrUrlInput] = useState('');
  // 单卡忙态（避免重复提交）。
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(true);

  // 后端许可名单快照（逐框校验用；提交/收录前另经 ensureLicenseGate 取真实门禁）。
  const [licenseGateSnapshot, setLicenseGateSnapshot] = useState<LicenseAllowlistResult | null>(null);
  const editor = usePendingDraftEditor(t, licenseGateSnapshot);
  const { loadIntoForm, clearErrors } = editor;

  // 表单 B/C 分节的展开/收起偏好（localStorage 持久化）
  const [openSections, setOpenSections] = useState(() => getPendingSectionPrefs());
  const toggleSection = (key: 'supplemental' | 'runtime') => {
    setOpenSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setPendingSectionPrefs(next);
      return next;
    });
  };

  const { loadLicenseGate } = customApps;
  // 启动预取（提交时大概率已就绪；失败静默，提交时再提示重试）。
  useEffect(() => {
    void loadLicenseGate().then((g) => {
      if (g) setLicenseGateSnapshot(g);
    });
  }, [loadLicenseGate]);

  // 提交/收录前确保名单就绪：拿不到则提示重试并返回 null（调用方中止，不开页不标记）。
  const ensureLicenseGate = async (): Promise<LicenseAllowlistResult | null> => {
    const gate = await loadLicenseGate();
    if (!gate) onNotify?.(t('pending.pr.allowlist_load_failed'), 'warning');
    else setLicenseGateSnapshot(gate);
    return gate;
  };

  // 切换顶层 Tab 时清空跨分组选中
  const handleGroupChange = (group: PendingGroupId) => {
    if (group === activeGroup) return;
    setActiveGroup(group);
    setSelectedId(null);
    setIsCreating(false);
    setPrUrlInput('');
    clearErrors();
  };

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

  const editingEntry = useMemo(() => {
    const found = entries.find((e) => e.id === selectedId) ?? null;
    // 跨 Tab 选中重置兜底：选中行不在当前 Tab 时视为无选中，走空态提示。
    // 平台筛选不参与判定：正在编辑的条目被筛出左栏时表单保持不丢失。
    if (found && !isCreating && entryGroup(found) !== activeGroup) return null;
    return found;
  }, [entries, selectedId, activeGroup, isCreating]);

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
    setPrUrlInput(found.pr_url ?? '');
    loadIntoForm(found.item);
  };

  const handleDuplicateDraft = () => {
    if (!editingEntry) return;
    // 复制为新草稿归 draft 分组：切回草稿 Tab 再展新建表单。
    setActiveGroup('draft');
    setIsCreating(true);
    setSelectedId(null);
    setPrUrlInput('');
    // 清空 id，修改 owner/repo 时自动联动新 id
    loadIntoForm({ ...editingEntry.item, id: '' });
    onNotify?.(t('pending.duplicated_hint'), 'info');
  };

  const handleSave = async () => {
    // 暂存档（DraftLenient）：仅校验身份，不卡 license/homepage/不完整字段；名单加载失败同样放行暂存。
    const { item, ok } = editor.validateForSave();
    if (!ok) {
      onNotify?.(t('pending.fix_errors'), 'warning');
      return;
    }
    // 复制/手输撞已存在 id：warning 提示并中断，不静默建第二条（也不静默覆盖）。
    if (isCreating && entries.some((e) => e.id === item.id)) {
      onNotify?.(t('pending.duplicate_conflict_hint', { id: item.id }), 'warning');
      return;
    }
    try {
      await customApps.handleSaveCustomApp(item);
    } catch (e) {
      // 落盘失败：停留编辑态（表单内容保留可重试）
      onNotify?.(t('pending.save_failed', { id: item.id, error: errorMessage(e) }), 'error');
      return;
    }
    setIsCreating(false);
    setSelectedId(item.id);
    // 保存后留在 draft 分组（新建/编辑均为草稿语义），避免切 Tab 后左右错配。
    setActiveGroup('draft');
    onNotify?.(t('pending.saved', { id: item.id }), 'success');
  };

  const handleDelete = async (id: string) => {
    try {
      await customApps.handleDeleteCustomApp(id);
    } catch (e) {
      onNotify?.(t('pending.delete_failed', { id, error: errorMessage(e) }), 'error');
      return;
    }
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
    try {
      await customApps.handleMarkCustomSubmitted(id, url);
    } catch (e) {
      // 落盘失败：停留原分组（不切已提交）
      onNotify?.(t('pending.mark_submitted_failed', { id, error: errorMessage(e) }), 'error');
      return;
    }
    // 手动标记后切到已提交：富卡仅展 Issue 链接，禁止重复提交。
    setActiveGroup('submitted');
    onNotify?.(t('pending.marked_submitted', { id }), 'success');
  };

  // 待提交退回草稿（已二次确认）：退回后仍留在待提交 Tab 并聚焦下一条
  const handleRevertToDraft = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || revertingId === id) return;
    if (target.archived || !isPendingCollectedStatus(target.status)) return;
    setRevertingId(id);
    try {
      await customApps.handleRevertCollectedApp(id);
      // 退回后停留 collected：不切 Tab；选中落到下一条同组行，无剩余则清空回空态。
      const collectedOrder = entries.filter((e) => !e.archived && isPendingCollectedStatus(e.status));
      const idx = collectedOrder.findIndex((e) => e.id === id);
      const remaining = collectedOrder.filter((e) => e.id !== id);
      const next =
        remaining.length === 0
          ? null
          : (remaining[Math.min(Math.max(idx, 0), remaining.length - 1)] ?? remaining[0] ?? null);
      setSelectedId(next ? next.id : null);
      setIsCreating(false);
      setPrUrlInput(next?.pr_url ?? '');
      if (next) loadIntoForm(next.item);
      else clearErrors();
      onNotify?.(t('pending.reverted', { id }), 'info');
    } catch (e) {
      onNotify?.(t('pending.revert_failed', { id, error: errorMessage(e) }), 'error');
    } finally {
      setRevertingId(null);
    }
  };

  // 标记为未提交（已二次确认，submitted → collected）：清空选中，条目随重拉进入待提交 Tab
  const handleWithdrawSubmitted = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || withdrawingId === id) return;
    if (target.archived || target.status !== 'submitted') return;
    setWithdrawingId(id);
    try {
      await customApps.handleWithdrawSubmitted(id);
      setSelectedId(null);
      setIsCreating(false);
      setPrUrlInput('');
      clearErrors();
      onNotify?.(t('pending.withdrawn', { id }), 'success');
    } catch (e) {
      onNotify?.(errorMessage(e), 'error');
    } finally {
      setWithdrawingId(null);
    }
  };

  // 收录进本地：确保许可名单就绪并校验通过后保存草稿并翻转为 collected
  const handleCollectLocal = async (id: string) => {
    const target = entries.find((e) => e.id === id);
    if (!target || collectingId === id) return;
    if (target.archived) return;
    if (target.status === 'submitted') {
      onNotify?.(t('pending.errors.already_submitted', { id }), 'warning');
      return;
    }
    if (isPendingCollectedStatus(target.status)) {
      onNotify?.(t('pending.already_collected', { id }), 'info');
      return;
    }
    const gate = await ensureLicenseGate();
    if (!gate) return;
    // 点击校验当前表单归一结果（错即内联 + 定位首错，不 toast）
    const { item, ok } = editor.validateForSubmit(gate);
    if (!ok) return;
    setCollectingId(id);
    try {
      // 收录前先把当前表单最新修改落盘。
      await customApps.handleSaveCustomApp(item);
      await customApps.handleCollectLocalApp(id);
      loadIntoForm(item);
      // 收录后切到待提交，右侧切富卡。
      setActiveGroup('to_submit');
      onNotify?.(t('pending.collected', { id }), 'success');
    } catch (e) {
      onNotify?.(errorMessage(e), 'error');
    } finally {
      setCollectingId(null);
    }
  };

  // 提交 Issue：校验许可名单后打开预填页；不自动标记 submitted，需用户回填链接确认
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
    if (!editor.validateForSubmit(gate).ok) return;
    setSubmittingId(id);
    try {
      const { getPrUrl, getPrPayload } = customApps;
      await runSubmitPrefillFlow(
        { t, notify: (message, type) => onNotify?.(message, type) },
        {
          loadUrl: getPrUrl ? () => getPrUrl(id) : undefined,
          loadPayload: getPrPayload ? () => getPrPayload(id) : undefined,
          failLabel: target.id,
        },
      );
      // 打开预填页后即止：不 mark submitted、不切分组，停留 collected 等手动确认。
    } finally {
      setSubmittingId(null);
    }
  };

  const showEditor = isCreating || editingEntry !== null;
  // 富卡分支：collected/submitted/archived 非新建一律富卡展示，仅 draft（含新建）走表单；archived 富卡只读 + 复制为新草稿。
  const isRichCollectedView = !isCreating && editingEntry !== null && entryGroup(editingEntry) !== 'draft';
  const richCardApp = useMemo(() => {
    if (!editingEntry) return null;
    return pendingDraftToAppSummary(editingEntry.item, editingEntry.status, editingEntry.archived);
  }, [editingEntry]);
  // 富卡态内联口径：live（快照）与提交尝试（formErrors，真实门禁）合并展示；已归档只读不展。
  const { liveSubmitErrors, formErrors } = editor;
  const richInlineErrors: PendingDraftErrors = useMemo(() => {
    if (!isRichCollectedView || editingEntry?.archived) return {};
    return { ...liveSubmitErrors, ...formErrors };
  }, [isRichCollectedView, liveSubmitErrors, formErrors, editingEntry]);

  return (
    <ViewShell viewClass="pending-view">
      {/* 页头 */}
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

      {/* 分组 Tab */}
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

      {/* 主区：全空时展示引导，有草稿时展示左右分栏 */}
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
                hasSubmitErrors={editor.hasSubmitErrors}
                hasLicenseSubmitError={editor.hasLicenseSubmitError}
                revertingId={revertingId}
                onRevertToDraft={(id) => void handleRevertToDraft(id)}
                withdrawingId={withdrawingId}
                onWithdrawSubmitted={(id) => void handleWithdrawSubmitted(id)}
                onDelete={(id) => void handleDelete(id)}
                onDuplicate={handleDuplicateDraft}
              />
            ) : (
              <>
                {/* 实时卡片预览窗口（Draft Visual / Post-inclusion preview lane） */}
                <PendingPreviewLane
                  form={editor.form}
                  previewPlatforms={editor.previewPlatforms}
                  expectedId={editor.expectedId}
                  expanded={previewExpanded}
                  onToggle={() => setPreviewExpanded((prev) => !prev)}
                />

                <PendingDraftForm
                  form={editor.form}
                  onField={editor.setField}
                  onTextField={editor.setTextField}
                  onFieldBlur={editor.onFieldBlur}
                  formErrors={formErrors}
                  aliasesText={editor.aliasesText}
                  platformsText={editor.platformsText}
                  identifiersText={editor.identifiersText}
                  isCreating={isCreating}
                  editing={editingEntry}
                  openSections={openSections}
                  onToggleSection={toggleSection}
                  onSave={handleSave}
                  onDelete={(id) => void handleDelete(id)}
                  collectingId={collectingId}
                  onCollectLocal={(id) => void handleCollectLocal(id)}
                  hasSubmitErrors={editor.hasSubmitErrors}
                  hasLicenseSubmitError={editor.hasLicenseSubmitError}
                />
              </>
            )}
          </div>
        </div>
      )}
    </ViewShell>
  );
};

