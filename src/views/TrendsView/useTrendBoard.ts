import { useEffect, useState } from 'react';
import { tauriApi } from '../../services/api';
import {
  boardGainKey,
  fetchTrendsResult,
  normalizeProxyPrefix,
  resolveTrendBoard,
  type TrendBoardId,
  type TrendsErrorKind,
  type TrendsResult,
} from '../../services/trends';

export function useTrendBoard(initialBoard: TrendBoardId = 'weekly') {
  const [board, setBoard] = useState<TrendBoardId>(initialBoard);
  // null = 加载中；非 null 按 status 分流：error → 错误面板，empty/ok → 列表或空状态。
  const [trendResult, setTrendResult] = useState<TrendsResult | null>(null);
  // 重试计数：递增即重触发抓取 effect。
  const [retryCount, setRetryCount] = useState(0);
  // gh-proxy 前缀：`active_mirror` 持久化在 Rust 侧设置库，前端经 getSettings 异步读；
  // 就绪前不抓取，避免先直连闪一次再带代理重抓。
  const [proxyPrefix, setProxyPrefix] = useState<string | undefined>(undefined);
  const [proxyReady, setProxyReady] = useState(false);

  // 陈旧榜兜底经 trends SSOT 回落（如已下线的 'top' / 'category' 残留 → 'weekly'）。
  const activeBoard: TrendBoardId = resolveTrendBoard(board);

  const gainKey = boardGainKey(activeBoard);
  const isLoading = trendResult === null;
  // 仅 status==='error' 才展示错误文案； genuine empty（status==='empty'）绝不走错误面板。
  const errorKind: TrendsErrorKind | undefined =
    trendResult?.status === 'error' ? (trendResult.errorKind ?? 'unavailable') : undefined;

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

    fetchTrendsResult(activeBoard, proxyPrefix ? { proxyPrefix } : {})
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
  }, [activeBoard, proxyPrefix, proxyReady, retryCount]);

  const handleRetry = () => setRetryCount((c) => c + 1);

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
  };
}
