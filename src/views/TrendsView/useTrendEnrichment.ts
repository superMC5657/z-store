import { useEffect } from 'react';
import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo, TrendsResult } from '../../types';
import { tauriApi } from '../../services/api';
import { enrichTrendRepos, type DetailPlatformsHealPayload, type DetailRichcardHealPayload } from '../../services/trends/enrich';
import {
  applyPlatformsHealToMirror,
  applyRichcardHealToMirror,
  boardRepoKeys,
  buildSwrFill,
  cleanupPlatformsHealConfirmed,
  collectEmptyIconKeys,
  collectMissingEnrichRepos,
  flushBoardPersistWithMirror,
  getBoardPersistKey,
  isPersistableIcon,
  maybePersistBoardNow,
  maybePersistRichcardHeal,
  maybeScheduleBoardPersist,
  mergeDbIconsIntoMirror,
  mergeEnrichFoundMirror,
  mergeSwrConfirmedMirror,
  mergeSwrEnrichedMirror,
  noteBoardReposForPersist,
  putBoardEnrichMemory,
  removeConfirmedForConcrete,
  resolveBoardCacheKey,
  subscribeBoardPersistOnConfirmedChange,
  subscribeTrendHealBus,
  unmarkConcreteKeys,
  unmarkPlatformsHealKeys,
} from '../../services/trends/board';
import {
  admitIconHit,
  patchIconMirror,
  queueAssembledRowIcons,
  subscribeIconWrites,
} from '../../services/iconStore';

/** 趋势榜富卡镜像（React 持有 + 同步 ref），由 View 创建、编排 hook 独占读写。 */
export interface TrendMirror {
  enrichedApps: Record<string, AppSummary>;
  setEnrichedApps: React.Dispatch<React.SetStateAction<Record<string, AppSummary>>>;
  enrichedAppsRef: React.MutableRefObject<Record<string, AppSummary>>;
  trendConfirmedOtherIds: Set<string>;
  setTrendConfirmedOtherIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/** 趋势可见行（catalog 富卡 / 未收录裸行）：enrich 编排与过滤共用形状。 */
export type DisplayTrendItem =
  | { type: 'catalog'; app: AppSummary; gain?: number }
  | { type: 'uncataloged'; repo: TrendRepo; gain?: number };

/** `useTrendEnrichment` 入参：榜单快照 + 可见行 + 榜标识 + 首绘门。 */
interface UseTrendEnrichmentParams {
  mirror: TrendMirror;
  trendResult: TrendsResult | null;
  displayItems: ReadonlyArray<DisplayTrendItem>;
  activeBoard: TrendBoardId;
  trendFetchOpts: FetchTrendsOptions;
  boardReady: boolean;
  refreshEnrichForceRef: React.MutableRefObject<boolean>;
}

/**
 * 趋势榜富卡编排（唯一深模块）：SWR 旧富卡直展、缺席仓 enrich、图标流式补齐、
 * 详情治愈总线、图标写扇出、L2 写透与卸载 flush 全部收口于此。
 *
 * View 只持有 `TrendMirror` 与渲染派生，effect 顺序与写透时机由本 hook 统一编排；
 * 内部一律经 `board.ts` seam（读写同源 key / 世代门控 / debounce 写透）。
 */
export function useTrendEnrichment({
  mirror,
  trendResult,
  displayItems,
  activeBoard,
  trendFetchOpts,
  boardReady,
  refreshEnrichForceRef,
}: UseTrendEnrichmentParams): void {
  const {
    enrichedApps,
    setEnrichedApps,
    enrichedAppsRef,
    setTrendConfirmedOtherIds,
  } = mirror;

  // SWR 旧富卡直展：榜缓存二级富信封命中后 boards 已 hydrate 进内存，
  // 此处经 board seam 同步合并进镜像先展旧富卡（含 loading 的 Other 加载中语义），不闪裸行；
  // 后台 enrich effect 再 revalidate 缺席项，找到具平台再覆盖写透；永不用空值覆盖已具平台值。
  // 合并逻辑收口 board（buildSwrFill + merge*Mirror），View 只做 load/refresh + 镜像持有。
  useEffect(() => {
    if (trendResult?.status !== 'ok' || trendResult.repos.length === 0) {
      return;
    }
    const { snap, l2Confirmed } = buildSwrFill(trendResult.repos);
    if (l2Confirmed.length > 0) {
      setTrendConfirmedOtherIds((prev) => mergeSwrConfirmedMirror(prev, l2Confirmed, snap));
    }
    setEnrichedApps((prev) => mergeSwrEnrichedMirror(prev, snap));
    // 组装落盘补齐：SWR 富卡 http 远端图标入队进盘（前 30 上限，内联/`data:` 与空跳过由店内裁决）。
    queueAssembledRowIcons(Object.values(snap));
    // 重挂图标自愈（DB-only）：快照缺失图标经本地 cycle 表回填，
    // 零网络/零 ETag；图标经店内唯一写口合流（`via=m2`，不占 `level`），已有实图永不覆写，上限与组装补齐同量级。
    const preview = mergeSwrEnrichedMirror(enrichedAppsRef.current, snap);
    const emptyKeys = collectEmptyIconKeys(preview);
    if (emptyKeys.length === 0) return;
    let cancelled = false;
    void (async () => {
      let icons: (string | null)[];
      try {
        icons = await tauriApi.getConfirmedIconsBatch(emptyKeys);
      } catch {
        return;
      }
      if (cancelled || !Array.isArray(icons)) return;
      const iconMap = new Map<string, string>();
      emptyKeys.forEach((k, i) => {
        const icon = icons[i];
        if (typeof icon === 'string' && icon.trim() !== '') iconMap.set(k, icon);
      });
      if (iconMap.size === 0) return;
      // 单一写口合流：镜像更新经 `mergeDbIconsIntoMirror`（内调 `admitIconHit`），
      // 返回补齐键供内存 hydrate；`data:` 只进 React 呈现，hydrate 前按可落盘过滤。
      const merged = mergeDbIconsIntoMirror(enrichedAppsRef.current, iconMap);
      if (merged.patchedKeys.length === 0) return;
      if (cancelled) return;
      setEnrichedApps(merged.next);
      // 内存 hydrate 供下次快照直展：已确认/具平台门控由 `put` 侧执行，
      // 未确认 loading 不进内存；写透经统一 debounce，不直写。
      try {
        const toHydrate: Record<string, AppSummary> = {};
        for (const k of merged.patchedKeys) {
          const row = merged.next[k];
          if (!row) continue;
          if (!isPersistableIcon(row.icon)) continue;
          toHydrate[k] = row;
        }
        if (Object.keys(toHydrate).length > 0) {
          putBoardEnrichMemory(toHydrate);
          const cacheKey = getBoardPersistKey();
          if (cacheKey) maybeScheduleBoardPersist(cacheKey);
        }
      } catch {
        // 内存同步失败不影响已呈现
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trendResult]);

  // Enter-intent：进 tab（挂载，含默认榜）即抓取，enrich 作为 board 落定后的跟随链运行。
  // 未收录行 enrichment：逐仓复用搜索 enrichment（Rust 侧并发 5、单次批量 40 上限、单仓 10s），
  // 成功合并为完整卡片；失败/无命中保持旧小行（enrichTrendRepos 缺席即不写，缺席即展裸行/旧缓存，不等齐）。
  // 合并 + 写透收口 board（collectMissing + mergeEnrichFoundMirror + maybePersistBoardNow）；
  // 裸行先展不拦榜，仅富卡升级受 boardReady 门控。
  useEffect(() => {
    if (trendResult?.status !== 'ok') return;
    // 刷新链跟随强制：手动 Refresh 落定后的本轮 enrich 消费一次标记，透传后端
    // force_refresh 做网络重拉；其余进 tab/切榜场景均为缓存允许路径。
    // 标记在本轮早消费（即使本轮无缺席项），避免泄漏到后续无关轮次造成误强制。
    const enrichForce = refreshEnrichForceRef.current;
    refreshEnrichForceRef.current = false;
    const missing = collectMissingEnrichRepos(displayItems, enrichedApps);
    if (missing.size === 0) return;
    let cancelled = false;
    // 写透时机：enrich 完成即同步 await 写透一次（关闭前 fire-and-forget 易丢，flush 兜底见下）。
    void enrichTrendRepos([...missing.values()], enrichForce ? { forceRefresh: true } : undefined).then(async (found) => {
      if (cancelled || found.size === 0) return;
      // 首绘门：裸行已直展，此处仅做升级；未就绪时延迟到 boardReady 置位后（下轮 effect 重入）。
      if (!boardReady) return;
      const { next, hasNewEnrich, concreteKeys } = mergeEnrichFoundMirror(
        enrichedAppsRef.current,
        found,
      );
      if (next !== enrichedAppsRef.current) setEnrichedApps(next);
      // 组装落盘补齐：本批 enrich 行 http 远端图标入队进盘（前 30 上限）。
      if (found.size > 0) queueAssembledRowIcons([...found.values()]);
      // 具平台到达可覆盖升级：enrich 具平台即移出已确认（本地 + board 内存标记）。
      if (concreteKeys.length > 0) {
        unmarkConcreteKeys(concreteKeys);
        setTrendConfirmedOtherIds((prev) => removeConfirmedForConcrete(prev, concreteKeys));
      }
      // enrich 落定后经 board seam 写透同榜 key（await 落稳再返回，刷新 cached_at 即刷新 12h 窗口）。
      if (hasNewEnrich && trendResult.repos.length > 0) {
        const { cacheKey, cacheBoard } = resolveBoardCacheKey(activeBoard, trendFetchOpts);
        await maybePersistBoardNow(cacheKey, cacheBoard, trendResult.repos);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendResult, displayItems, activeBoard, trendFetchOpts, boardReady]);

  // 当前榜快照同步（供 board debounce/pagehide/confirm 链读取）。
  // 读写同源：key 与 boards 读路径同源（同 board + 同 trendFetchOpts），杜绝读写分叉。
  useEffect(() => {
    if (trendResult?.status !== 'ok' || trendResult.repos.length === 0) return;
    const { cacheKey, cacheBoard } = resolveBoardCacheKey(activeBoard, trendFetchOpts);
    noteBoardReposForPersist({ cacheKey, cacheBoard, repos: trendResult.repos });
  }, [trendResult, activeBoard, trendFetchOpts]);

  useEffect(() => {
    const flush = (): void => {
      try {
        flushBoardPersistWithMirror(enrichedAppsRef.current);
      } catch {
        // 卸载兜底不抛错
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // 已确认变更写透联动：经 board 统一订阅（mark/unmark 触发节流写透；读路径不触发）。
  useEffect(() => {
    return subscribeBoardPersistOnConfirmedChange();
  }, []);

  // 趋势流式图标订阅。
  // 后台 `icon-ready` 经 `admitIconHit` 接上 `board` 门控逐个补齐富卡图标。
  // 此处只 patch 图标（空值规则由店内保证），
  // 平台逻辑不动；`data:` 只进 M1 内存，`remote`（含 m2 回退远端）才 hydrate + 节流写透榜缓存二级。
  // 双门控正交（勿删其一）：`kind` 门控做榜/搜隔离（本订阅只收 `trend`，search 交 App 处理）；
  // `admitIconHit` 内 `search_id/board+gen` 门控做同榜新鲜度判定（双非空不等即 stale，任一为空即放行）。
  // 前者防跨榜串写（空 board/gen 在店内一律放行，无 kind 硬过滤即串榜），后者防同榜过期回放；两者不可互相替代。
  // hydrate/写透经 board seam（putBoardEnrichMemory + maybeScheduleBoardPersist）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void tauriApi
      .onIconReady((payload) => {
        if (cancelled) return;
        const raw = (payload ?? {}) as unknown as Record<string, unknown>;
        const ctx = (raw['context'] ?? null) as {
          kind: string;
          search_id?: string;
          board?: string;
          gen?: number;
        } | null;
        const kind =
          ctx && typeof ctx.kind === 'string' ? ctx.kind.trim().toLowerCase() : '';
        // 榜隔离：趋势只消费 `trend` 上下文；搜索（`search`）交 App 处理。
        // 空 kind 亦拒绝——店内世代门控任一为空即放行，此处必须严格，否则空 search_id/board/gen 的搜索命中会串写榜单行。
        if (kind !== 'trend') return;
        const asStr = (v: unknown): string | undefined =>
          typeof v === 'string' ? v : undefined;
        const res = admitIconHit({
          id: asStr(raw['id']),
          icon: asStr(raw['icon']),
          level: typeof raw['level'] === 'number' ? (raw['level'] as number) : undefined,
          via: asStr(raw['via']),
          context: ctx,
          board: activeBoard,
          getCurrentIcon: (tid) => {
            const lk = tid.toLowerCase();
            return enrichedAppsRef.current[lk]?.icon;
          },
          patch: (tid, icon) => {
            setEnrichedApps((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const k of Object.keys(prev)) {
                const cur = prev[k];
                const alias = String(cur?.id ?? '').trim().toLowerCase();
                if (k.toLowerCase() === tid || (alias !== '' && alias === tid)) {
                  if (cur.icon !== icon) {
                    next[k] = { ...cur, icon };
                    changed = true;
                  }
                }
              }
              return changed ? next : prev;
            });
          },
        });
        if (!res.accepted || !res.icon) return;
        // 图标落盘：已 patch 条目经 board seam hydrate 快照 + 节流写透同榜 key。
        try {
          const targets = res.targets ?? [];
          if (targets.length === 0) return;
          const latest = enrichedAppsRef.current;
          const toHydrate: Record<string, AppSummary> = {};
          for (const t of targets) {
            for (const k of Object.keys(latest)) {
              const cur = latest[k];
              if (!cur) continue;
              const alias = String(cur.id ?? '').trim().toLowerCase();
              if (k.toLowerCase() === t || (alias !== '' && alias === t)) {
                toHydrate[k] = { ...cur, icon: res.icon };
              }
            }
          }
          if (Object.keys(toHydrate).length === 0) return;
          putBoardEnrichMemory(toHydrate);
          const cacheKey = getBoardPersistKey();
          if (!cacheKey) return;
          maybeScheduleBoardPersist(cacheKey);
        } catch {
          // 落盘失败不影响内存即时补齐
        }
      })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch(() => {
        // 非 Tauri 环境（单测/浏览器预览）无事件总线：静默跳过，enrich 等齐路照旧
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activeBoard]);

  // 治愈总线统一订阅：2 路 window 事件（detail-platforms / detail-richcard）
  // 经 board 同一归一 upsert 路径进镜像（normalizeHealKeys + boardRepoKeys 过滤跨榜）。
  // 图标经 `icon-ready → admitIconHit` 唯一写口逐个补齐（见上流式订阅），不走窗口总线。
  // key 归一 lower-trim 同源。
  useEffect(() => {
    return subscribeTrendHealBus({
      onPlatformsHeal: (payload: DetailPlatformsHealPayload, keys: string[]) => {
        const repoKeys = boardRepoKeys(trendResult?.repos);
        setEnrichedApps((prev) =>
          applyPlatformsHealToMirror(prev, keys, payload.summary, payload.platforms, repoKeys),
        );
        setTrendConfirmedOtherIds((prev) => cleanupPlatformsHealConfirmed(prev, keys));
        // 具平台升级同步清 board 内存确认标记（App 侧 upsert 已清同键，此处补清别名）。
        unmarkPlatformsHealKeys(keys);
      },
      onRichcardHeal: (payload: DetailRichcardHealPayload) => {
        const repoKeys = boardRepoKeys(trendResult?.repos);
        setEnrichedApps((prev) => applyRichcardHealToMirror(prev, payload, repoKeys));
        maybePersistRichcardHeal(enrichedAppsRef.current, payload, repoKeys);
      },
    });
  }, [trendResult]);

  // 图标写扇出订阅（读侧）：店内唯一写口受理后镜像跟进——覆盖无 patch 的本地写
  // （如详情轮转切 L5 只调 `admitIconHit` 不带 patch，榜单行经此清徽章）。
  // 纯内存合并（`patchIconMirror` 单 interface；`''`/`data:` 不 hydrate/写透，
  // 与 `persistIconChanged` 同规则）；持久化源为 cycle 行/detail_json，remount 重衍生。
  // 卸载即退订。
  useEffect(() => {
    return subscribeIconWrites(({ targets, icon }) => {
      for (const t of targets) {
        setEnrichedApps((prev) => patchIconMirror(prev, t, icon));
      }
    });
  }, []);
}
