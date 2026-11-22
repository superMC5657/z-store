/**
 * 待收录草稿域 hook：后端草稿列表、本地库摘要与移入抑制集派生、写盘重拉，
 * 以及待收录页依赖的协议白名单单飞查询与 Issue 预填获取。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import type { LicenseAllowlistResult } from '../../services/api/catalog';
import {
  entryFromWire,
  entryToCollectedSummary,
  itemToWire,
  type DraftEntry,
  type DraftItem,
} from '../../services/custom';
import { isLocalLibraryStatus, rowAliasKeys } from '../selectors';

/** 演示站：无后端持久化与系统浏览器，Issue 预填缺席，待收录页据此显示「仅桌面端」提示。 */
const DEMO_MODE = Boolean(import.meta.env.VITE_DEMO);

export const CUSTOM_APPS_CHANGED_EVENT = 'zstore:custom-apps-changed';

export interface UseCustomAppsOptions {
  /** 缺省取构建期 `VITE_DEMO`。 */
  demoMode?: boolean;
}

/**
 * 归一许可名单响应：门禁开 + 空名单视为无效快照（等价加载失败，不拿空名单误拦提交）。
 */
function normalizeGate(raw: LicenseAllowlistResult | null | undefined): LicenseAllowlistResult | null {
  const allowed = Array.isArray(raw?.allowed)
    ? raw.allowed.filter((s): s is string => typeof s === 'string')
    : [];
  if (raw?.enabled !== false && allowed.length === 0) return null;
  return { enabled: raw?.enabled !== false, allowed };
}

export function useCustomApps(options: UseCustomAppsOptions = {}) {
  const demoMode = options.demoMode ?? DEMO_MODE;
  // 待收录草稿后端列表（null = 未加载/非 Tauri 预览）。
  const [customApps, setCustomApps] = useState<DraftEntry[] | null>(null);

  const reloadCustomApps = useCallback(async () => {
    try {
      const wires = await tauriApi.listCustomApps(true);
      setCustomApps(wires.map(entryFromWire));
    } catch {
      // 非 Tauri 预览/后端未就绪：保持 null，待收录页按空列表渲染
      setCustomApps(null);
    }
  }, []);

  // 乐观移入 id（归一小写）：移入当刻即隐藏收录入口，不依赖后端往返。
  const [movedInIds, setMovedInIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  // 挂载拉取并监听跨视图草稿变更事件（事件可携带 `detail.id` 作乐观移入）。
  useEffect(() => {
    void reloadCustomApps();
    const onChanged = (e: Event) => {
      const id = (e as CustomEvent<{ id?: unknown } | undefined>).detail?.id;
      const keys = rowAliasKeys({ id });
      if (keys.length > 0) {
        setMovedInIds((prev) => {
          if (keys.every((k) => prev.has(k))) return prev;
          const next = new Set(prev);
          for (const k of keys) next.add(k);
          return next;
        });
      }
      void reloadCustomApps();
    };
    window.addEventListener(CUSTOM_APPS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(CUSTOM_APPS_CHANGED_EVENT, onChanged);
    };
  }, [reloadCustomApps]);

  // 侧栏「待收录」角标按平台过滤口径由 `useAppSelectors().pendingFilteredCount` 派生。
  const customAppEntries = useMemo(() => customApps ?? undefined, [customApps]);

  // 移入收录入口抑制集：后端全量草稿 id（含 owner/repo 别名）+ 乐观移入 id。
  const customIds = useMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>(movedInIds);
    for (const e of customApps ?? []) {
      for (const k of rowAliasKeys({ id: e.id, owner: e.item?.owner, repo: e.item?.repo })) {
        out.add(k);
      }
    }
    return out;
  }, [customApps, movedInIds]);

  // 写盘后重拉草稿列表并广播目录同步，保持合并目录同代；失败只向上抛（不重拉），由调用方提示。
  const mutateAndReload = useCallback(
    async (mutate: () => Promise<unknown>) => {
      await mutate();
      await reloadCustomApps();
      window.dispatchEvent(new CustomEvent('zstore:catalog-synced'));
    },
    [reloadCustomApps],
  );

  const handleSaveCustomApp = useCallback(
    async (draft: DraftItem) => {
      const existing = customApps?.find((e) => e.id === draft.id);
      await mutateAndReload(() => tauriApi.saveCustomApp(itemToWire(draft, existing?.item)));
    },
    [customApps, mutateAndReload],
  );
  const handleDeleteCustomApp = useCallback(
    (id: string) => mutateAndReload(() => tauriApi.deleteCustomApp(id)),
    [mutateAndReload],
  );
  const handleMarkCustomSubmitted = useCallback(
    (id: string, prUrl: string) => mutateAndReload(() => tauriApi.markCustomSubmitted(id, prUrl)),
    [mutateAndReload],
  );
  const handleCollectLocalApp = useCallback(
    (id: string) => mutateAndReload(() => tauriApi.collectLocalApp(id)),
    [mutateAndReload],
  );
  const handleWithdrawSubmitted = useCallback(
    (id: string) => mutateAndReload(() => tauriApi.withdrawSubmitted(id)),
    [mutateAndReload],
  );
  const handleRevertCollectedApp = useCallback(
    (id: string) => mutateAndReload(() => tauriApi.revertCollectedApp(id)),
    [mutateAndReload],
  );

  // 协议白名单单飞查询：并发调用共用一次请求；失败或无效快照返回 null（fail-closed）并允许下次重试。
  const licenseGateRequestRef = useRef<Promise<LicenseAllowlistResult | null> | null>(null);
  const loadLicenseGate = useCallback((): Promise<LicenseAllowlistResult | null> => {
    if (licenseGateRequestRef.current) return licenseGateRequestRef.current;
    const request = (async () => {
      try {
        const gate = normalizeGate(await tauriApi.getLicenseAllowlist());
        if (!gate) licenseGateRequestRef.current = null;
        return gate;
      } catch {
        licenseGateRequestRef.current = null;
        return null;
      }
    })();
    licenseGateRequestRef.current = request;
    return request;
  }, []);

  // Issue 预填（单条 URL / JSON 载荷）：演示站缺席。
  const getPrUrl = useMemo(
    () => (demoMode ? undefined : (id: string) => tauriApi.getCustomAppPrUrl(id)),
    [demoMode],
  );
  const getPrPayload = useMemo(
    () => (demoMode ? undefined : (id: string) => tauriApi.getCustomAppPrPayload(id)),
    [demoMode],
  );

  // 本地库合并流：仅库内成员（collected 系 + 已提交 submitted）且未归档进入首页/分类（可搜可装，橘黄 local 徽标）。
  const localLibrarySummaries = useMemo(() => {
    const out: Array<AppSummary & { status: string; archived: boolean }> = [];
    for (const e of customApps ?? []) {
      if (e.archived || !isLocalLibraryStatus(e.status)) continue;
      out.push(entryToCollectedSummary(e));
    }
    return out;
  }, [customApps]);

  return {
    customApps,
    customAppEntries,
    customIds,
    localLibrarySummaries,
    handleSaveCustomApp,
    handleDeleteCustomApp,
    handleMarkCustomSubmitted,
    handleCollectLocalApp,
    handleWithdrawSubmitted,
    handleRevertCollectedApp,
    loadLicenseGate,
    getPrUrl,
    getPrPayload,
  };
}

export type CustomAppsStore = ReturnType<typeof useCustomApps>;
