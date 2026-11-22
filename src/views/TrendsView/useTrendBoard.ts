import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  boardGainKey,
  fetchTrendsResult,
  resolveTrendBoard,
  subscribeBoardHydrated,
} from '../../services/trends';
import type {
  TrendBoardId,
  TrendsErrorKind,
  TrendsResult,
} from '../../types';

/** 趋势榜选项卡记忆键（localStorage 同步读写，首绘即恢复）。 */
export const TREND_BOARD_STORAGE_KEY = 'zstore.trends.opts';

/** 同步读上次选中的榜单：信封 `{ board: string }` 解析；缺失/损坏/非法一律 undefined（经 SSOT resolve）。 */
export function loadPersistedTrendBoard(): TrendBoardId | undefined {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return undefined;
    const raw = window.localStorage.getItem(TREND_BOARD_STORAGE_KEY);
    if (!raw) return undefined;
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return undefined;
    }
    // JSON-string 形 '"weekly"'：已 parse 一层得 board 字符串；若该字符串自身仍是 JSON
    //（双重编码信封），再 parse 一层后按信封检查；裸数组等非信封一律拒绝。
    if (typeof candidate === 'string') {
      const s = candidate;
      try {
        const inner: unknown = JSON.parse(s);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          const b = (inner as { board?: unknown }).board;
          if (typeof b === 'string' && b) return resolveTrendBoard(b);
          return undefined;
        }
      } catch {
        // 非 JSON 字符串：按 board 名直判（合法即接受，非法即 undefined）。
      }
      return resolveTrendBoard(s);
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const b = (candidate as { board?: unknown }).board;
      if (typeof b === 'string' && b) return resolveTrendBoard(b);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 同步写当前榜单（切换时调用；写失败静默忽略，不影响榜单展示）。 */
export function persistTrendBoard(board: TrendBoardId): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(
      TREND_BOARD_STORAGE_KEY,
      JSON.stringify({ board: resolveTrendBoard(board) ?? 'weekly' }),
    );
  } catch {
    // 配额/隐私模式写失败：本次会话仍可用内存态，忽略。
  }
}

export function useTrendBoard(initialBoard: TrendBoardId = 'weekly') {
  // 从 localStorage 同步恢复上次选中的榜单，确保首绘不闪切
  const [board, setBoardState] = useState<TrendBoardId>(() => {
    const persisted = loadPersistedTrendBoard();
    if (persisted !== undefined) return persisted;
    return resolveTrendBoard(initialBoard) ?? 'weekly';
  });
  // null = 加载中；非 null 按 status 分流：error → 错误面板，empty/ok → 列表或空状态。
  const [trendResult, setTrendResult] = useState<TrendsResult | null>(null);
  // 重试计数：递增即重触发抓取 effect。
  const [retryCount, setRetryCount] = useState(0);
  // 手动刷新态：与首载 isLoading 分离，刷新期间保留旧榜（SWR  stale 展），仅按钮转圈 + 禁用。
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshSeqRef = useRef(0);
  // 刷新链 enrich 强制标记：手动 Refresh 成功落定后，跟随的 enrich effect 消费一次
  // （读后即清零），透传后端 force_refresh 做网络重拉；其余 effect 抓取均为缓存允许路径。
  const refreshEnrichForceRef = useRef(false);
  // 首屏就绪标记：由榜单水合订阅与抓取落定共同置位
  const [boardReady, setBoardReady] = useState(false);

  // 经 trends SSOT 归一（非法输入边界回落 weekly，仅此一处回落语义）。
  const activeBoard: TrendBoardId = resolveTrendBoard(board) ?? 'weekly';

  const gainKey = boardGainKey(activeBoard);
  const isLoading = trendResult === null;
  // 仅 status==='error' 才展示错误文案； genuine empty（status==='empty'）绝不走错误面板。
  const errorKind: TrendsErrorKind | undefined =
    trendResult?.status === 'error' ? (trendResult.errorKind ?? 'unavailable') : undefined;

  // 一榜一源：board / 重试任一变化均触发重抓。
  // 就绪订阅单 emit 源单订阅（L1/L2/网络三路径统一 emit，不双订）。
  useEffect(() => {
    return subscribeBoardHydrated(() => {
      setBoardReady(true);
    });
  }, []);

  // 挂载、切换子榜或重试时拉取榜单（SWR/缓存优先）
  useEffect(() => {
    let isMounted = true;
    setTrendResult(null);
    // 现状：读盘前未就绪，View 裸行直展不拦榜（门信号仅供升级判定）。
    setBoardReady(false);

    fetchTrendsResult(activeBoard)
      .then((res) => {
        if (!isMounted) return;
        setTrendResult(res);
        // 幂等兜底：boards 内三路径已统一 emit（订阅置位），此处直接置位防事件竞态漏置。
        setBoardReady(true);
      })
      .catch(() => {
        // service 按契约应总 resolve；此处兜底未知异常，归为 unavailable。
        if (!isMounted) return;
        setTrendResult({ repos: [], status: 'error', errorKind: 'unavailable', stale: false });
        setBoardReady(true);
      });

    return () => {
      isMounted = false;
    };
  }, [activeBoard, retryCount]);

  const handleRetry = () => setRetryCount((c) => c + 1);

  // 手动刷新：直抓远端覆盖当前榜单（刷新期间保留旧榜，seq 守卫丢弃过期落定）
  const activeBoardRef = useRef(activeBoard);
  activeBoardRef.current = activeBoard;
  const handleRefresh = useCallback(() => {
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    const boardAtClick = activeBoardRef.current;
    setIsRefreshing(true);
    fetchTrendsResult(boardAtClick, { forceRefresh: true })
      .then((res) => {
        if (seq !== refreshSeqRef.current) return;
        if (activeBoardRef.current !== boardAtClick) return;
        // 刷新链 enrich 跟随强制：board 落定后 effect 内消费一次。
        refreshEnrichForceRef.current = true;
        setTrendResult(res);
      })
      .catch(() => {
        // service 按契约应总 resolve；此处兜底未知异常，归为 unavailable。
        if (seq !== refreshSeqRef.current) return;
        if (activeBoardRef.current !== boardAtClick) return;
        setTrendResult({ repos: [], status: 'error', errorKind: 'unavailable', stale: false });
      })
      .finally(() => {
        if (seq === refreshSeqRef.current) setIsRefreshing(false);
      });
  }, []);

  // 切换即同步写盘（与榜单内容无关；非法值经 SSOT 归一 weekly）。
  const setBoard: Dispatch<SetStateAction<TrendBoardId>> = useCallback((next) => {
    if (typeof next === 'function') {
      setBoardState((prev) => {
        const resolved =
          resolveTrendBoard(
            (next as (p: TrendBoardId) => TrendBoardId)(prev),
          ) ?? 'weekly';
        persistTrendBoard(resolved);
        return resolved;
      });
      return;
    }
    const resolved = resolveTrendBoard(next) ?? 'weekly';
    persistTrendBoard(resolved);
    setBoardState(resolved);
  }, []);

  return {
    board,
    setBoard,
    activeBoard,
    trendResult,
    setTrendResult,
    gainKey,
    isLoading,
    boardReady,
    errorKind,
    handleRetry,
    isRefreshing,
    handleRefresh,
    refreshEnrichForceRef,
  };
}
