import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { tauriApi } from '../../services/api';
import {
  boardGainKey,
  fetchTrendsResult,
  normalizeProxyPrefix,
  resolveTrendBoard,
  type FetchTrendsOptions,
  type TrendBoardId,
  type TrendsErrorKind,
  type TrendsResult,
} from '../../services/trends';

/**
 * 趋势榜选项卡记忆键：localStorage 单一来源（同步读写，首绘即恢复，无闪切）。
 * 信封 `{ board }` 预留 language/category 扩展位；读兼容裸字符串/JSON 字符串旧写。
 */
export const TREND_BOARD_STORAGE_KEY = 'zstore.trends.opts';

/** 同步读上次选中的榜单：缺失/损坏/非法一律回落 'weekly'（经 SSOT resolve）。 */
export function loadPersistedTrendBoard(): TrendBoardId | undefined {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return undefined;
    const raw = window.localStorage.getItem(TREND_BOARD_STORAGE_KEY);
    if (!raw) return undefined;
    let candidate: unknown = raw;
    try {
      candidate = JSON.parse(raw);
    } catch {
      candidate = raw;
    }
    if (typeof candidate === 'string') {
      return candidate ? resolveTrendBoard(candidate) : undefined;
    }
    if (candidate && typeof candidate === 'object') {
      const b = (candidate as { board?: unknown }).board;
      if (typeof b === 'string' && b) return resolveTrendBoard(b);
      return undefined;
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
      JSON.stringify({ board: resolveTrendBoard(board) }),
    );
  } catch {
    // 配额/隐私模式写失败：本次会话仍可用内存态，忽略。
  }
}

export function useTrendBoard(initialBoard: TrendBoardId = 'weekly') {
  // 选项卡记忆：localStorage 同步读（首绘即正确榜，无闪切）。
  // 未选用 Rust 设置表通道：getSettings 为异步，首屏前无法同步注水，
  // 会先闪 weekly 再跳榜；localStorage 即单一来源。
  const [board, setBoardState] = useState<TrendBoardId>(() => {
    const persisted = loadPersistedTrendBoard();
    if (persisted !== undefined) return persisted;
    return resolveTrendBoard(initialBoard);
  });
  // null = 加载中；非 null 按 status 分流：error → 错误面板，empty/ok → 列表或空状态。
  const [trendResult, setTrendResult] = useState<TrendsResult | null>(null);
  // 重试计数：递增即重触发抓取 effect。
  const [retryCount, setRetryCount] = useState(0);
  // gh-proxy 前缀：`active_mirror` 持久化在 Rust 侧设置库，前端经 getSettings 异步读；
  // 就绪前不抓取，避免先直连闪一次再带代理重抓。
  const [proxyPrefix, setProxyPrefix] = useState<string | undefined>(undefined);
  const [proxyReady, setProxyReady] = useState(false);
  // 手动刷新态：与首载 isLoading 分离，刷新期间保留旧榜（SWR  stale 展），仅按钮转圈 + 禁用。
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshSeqRef = useRef(0);

  // 陈旧榜兜底经 trends SSOT 回落（如已下线的 'top' / 'category' 残留 → 'weekly'）。
  const activeBoard: TrendBoardId = resolveTrendBoard(board);

  const gainKey = boardGainKey(activeBoard);
  const isLoading = trendResult === null;
  // 仅 status==='error' 才展示错误文案； genuine empty（status==='empty'）绝不走错误面板。
  const errorKind: TrendsErrorKind | undefined =
    trendResult?.status === 'error' ? (trendResult.errorKind ?? 'unavailable') : undefined;

  // P1-C3 读写同源：抓取所用的 opts 即缓存键所用的 opts（与 boards.ts:204/214/240 同源）。
  // 当前仅含 proxyPrefix（builders 忽略该字段，仅 language/category 参与键）；后续若接入
  // language/category 筛选，此处一并透传即可保证 L1/L2 读写同 key。
  const trendFetchOpts: FetchTrendsOptions = useMemo(
    () => (proxyPrefix ? { proxyPrefix } : {}),
    [proxyPrefix],
  );

  useEffect(() => {
    let cancelled = false;
    tauriApi
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        // 经 trends SSOT 归一化（'direct'/空 → 直连；其余透传，抓取恒直连忽略）。
        setProxyPrefix(normalizeProxyPrefix(s?.active_mirror));
        setProxyReady(true);
      })
      .catch(() => {
        // 非 Tauri 环境（浏览器预览/单测）无设置库：直连。
        if (cancelled) return;
        setProxyPrefix(undefined);
        setProxyReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 一榜一源：board / 代理 / 重试任一变化均触发重抓。
  useEffect(() => {
    if (!proxyReady) return;
    let isMounted = true;
    setTrendResult(null);

    fetchTrendsResult(activeBoard, trendFetchOpts)
      .then((res) => {
        if (!isMounted) return;
        setTrendResult(res);
      })
      .catch(() => {
        // service 按契约应总 resolve；此处兜底未知异常，归为 unavailable。
        if (!isMounted) return;
        setTrendResult({ repos: [], status: 'error', errorKind: 'unavailable' });
      });

    return () => {
      isMounted = false;
    };
  }, [activeBoard, proxyReady, retryCount, trendFetchOpts]);

  const handleRetry = () => setRetryCount((c) => c + 1);

  // 手动刷新：沿用 trendFetchOpts 同源 key 仅叠加 forceRefresh，直抓链路跳过 L1/L2，
  // 成功经 boards 内 SWR 写透落盘；失败沿错误契约进现有 error lane（不弹框）。
  // 不经过 retryCount effect（避免双抓），旧榜在刷新期间保留展示；切榜/并发以 seq 守卫丢弃过期落定。
  const activeBoardRef = useRef(activeBoard);
  activeBoardRef.current = activeBoard;
  const trendFetchOptsRef = useRef(trendFetchOpts);
  trendFetchOptsRef.current = trendFetchOpts;
  const handleRefresh = useCallback(() => {
    if (!proxyReady) return;
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    const boardAtClick = activeBoardRef.current;
    const optsAtClick = trendFetchOptsRef.current;
    setIsRefreshing(true);
    fetchTrendsResult(boardAtClick, { ...optsAtClick, forceRefresh: true })
      .then((res) => {
        if (seq !== refreshSeqRef.current) return;
        if (activeBoardRef.current !== boardAtClick) return;
        setTrendResult(res);
      })
      .catch(() => {
        // service 按契约应总 resolve；此处兜底未知异常，归为 unavailable。
        if (seq !== refreshSeqRef.current) return;
        if (activeBoardRef.current !== boardAtClick) return;
        setTrendResult({ repos: [], status: 'error', errorKind: 'unavailable' });
      })
      .finally(() => {
        if (seq === refreshSeqRef.current) setIsRefreshing(false);
      });
  }, [proxyReady]);

  // 切换即同步写盘（与榜单内容无关；非法值经 SSOT 回落 weekly）。
  const setBoard: Dispatch<SetStateAction<TrendBoardId>> = useCallback((next) => {
    if (typeof next === 'function') {
      setBoardState((prev) => {
        const resolved = resolveTrendBoard(
          (next as (p: TrendBoardId) => TrendBoardId)(prev),
        );
        persistTrendBoard(resolved);
        return resolved;
      });
      return;
    }
    const resolved = resolveTrendBoard(next);
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
    errorKind,
    handleRetry,
    isRefreshing,
    handleRefresh,
    trendFetchOpts,
  };
}
