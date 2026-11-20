import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendsResult } from '../../types';
import { tauriApi } from '../../services/api';
import { createTrendBoardSession, type DisplayTrendItem } from '../../services/trends';
import { unionConfirmedSets } from '../../lib/platformFilter';

export type { DisplayTrendItem };

interface UseTrendEnrichmentParams {
  trendResult: TrendsResult | null;
  rawItems: ReadonlyArray<DisplayTrendItem>;
  getDisplayItems: () => ReadonlyArray<DisplayTrendItem>;
  activeBoard: TrendBoardId;
  trendFetchOpts: FetchTrendsOptions;
  boardReady: boolean;
  refreshEnrichForceRef: React.MutableRefObject<boolean>;
  globalConfirmed?: ReadonlySet<string>;
}

/** 趋势榜富卡会话的 React 生命周期适配器：将会话状态与副作用绑定到组件树。 */
export function useTrendEnrichment({
  trendResult,
  rawItems,
  getDisplayItems,
  activeBoard,
  trendFetchOpts,
  boardReady,
  refreshEnrichForceRef,
  globalConfirmed,
}: UseTrendEnrichmentParams): {
  enrichedApps: Record<string, AppSummary>;
  combinedConfirmed: Set<string>;
} {
  const [session] = useState(() => createTrendBoardSession());
  const [mirror, setMirror] = useState(() => session.getSnapshot());

  const getDisplayItemsRef = useRef(getDisplayItems);
  getDisplayItemsRef.current = getDisplayItems;

  useEffect(() => {
    setMirror(session.getSnapshot());
    const unsub = session.subscribe(setMirror);
    session.start();
    return () => {
      unsub();
      session.dispose();
    };
  }, [session]);

  useEffect(() => {
    session.syncBoard({ trendResult, activeBoard, trendFetchOpts });
  }, [session, trendResult, activeBoard, trendFetchOpts]);

  useEffect(() => {
    session.resetLoadingBoard(activeBoard, trendResult);
  }, [session, activeBoard, trendResult]);

  useEffect(() => {
    session.syncEnrichment({
      trendResult,
      activeBoard,
      trendFetchOpts,
      displayItems: getDisplayItemsRef.current(),
      boardReady,
      consumeForceEnrich: () => {
        const force = refreshEnrichForceRef.current;
        refreshEnrichForceRef.current = false;
        return force;
      },
    });
  }, [session, trendResult, activeBoard, trendFetchOpts, boardReady, refreshEnrichForceRef]);

  const combinedConfirmed = useMemo(
    () => unionConfirmedSets(globalConfirmed, mirror.confirmedOtherIds),
    [globalConfirmed, mirror.confirmedOtherIds],
  );

  useEffect(() => {
    session.syncLiteVerify({
      trendResult,
      rawItems,
      activeBoard,
      globalConfirmed,
      fetchLite: (liteId) => tauriApi.getPlatformsLite(liteId),
    });
  }, [
    session,
    trendResult,
    rawItems,
    mirror.enrichedApps,
    globalConfirmed,
    combinedConfirmed,
    activeBoard,
    trendFetchOpts,
  ]);

  useEffect(() => {
    return session.scheduleSettle({
      trendResult,
      rawItems,
      globalConfirmed,
    });
  }, [
    session,
    trendResult,
    rawItems,
    mirror.enrichedApps,
    globalConfirmed,
    combinedConfirmed,
    activeBoard,
    trendFetchOpts,
  ]);

  return {
    enrichedApps: mirror.enrichedApps,
    combinedConfirmed,
  };
}
