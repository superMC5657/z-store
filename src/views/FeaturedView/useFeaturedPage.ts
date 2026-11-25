import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeaturedPage, FeedbackScope } from '../../types';
import { tauriApi } from '../../services/api';

/** 平台筛选结果抖动（平台补探陆续落定）时合并请求的等待时间。 */
const ALLOWED_IDS_DEBOUNCE_MS = 250;

/** 精选页整页货架数据与负反馈状态：随平台筛选或显式 reload 拉取，不响应实时画像变化。 */
export function useFeaturedPage(allowedIds: readonly string[], visitSeed: number) {
  const [page, setPage] = useState<FeaturedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);

  const signature = useMemo(() => [...allowedIds].map((id) => id.toLowerCase()).sort().join(','), [allowedIds]);
  const idsRef = useRef(allowedIds);
  idsRef.current = allowedIds;
  const hasPageRef = useRef(false);
  hasPageRef.current = page !== null;
  // 请求序号：只采用比已采用结果更新的响应，较早的请求不取消（首屏尽快出结果）。
  const issuedRef = useRef(0);
  const appliedRef = useRef(0);

  const hasIds = allowedIds.length > 0;
  useEffect(() => {
    // 平台筛选为空时页面渲染筛选空态，不发请求。
    if (!hasIds) {
      setLoading(false);
      return;
    }
    const run = () => {
      const seq = ++issuedRef.current;
      setLoading(true);
      setFailed(false);
      tauriApi
        .getFeaturedPage(visitSeed, idsRef.current)
        .then((res) => {
          if (seq <= appliedRef.current) return;
          appliedRef.current = seq;
          setPage(res);
          setFailed(false);
          if (seq === issuedRef.current) setLoading(false);
        })
        .catch(() => {
          if (seq !== issuedRef.current) return;
          setFailed(true);
          setLoading(false);
        });
    };
    // 首屏立即请求；已有页面时合并平台补探引起的连续变化。
    if (!hasPageRef.current) {
      run();
      return;
    }
    const timer = setTimeout(run, ALLOWED_IDS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [signature, visitSeed, reloadSeq, hasIds]);

  const reload = useCallback(() => setReloadSeq((n) => n + 1), []);

  // ---- 负反馈：卡片就地淡出，不补位、不重排；失败恢复 ----
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const dismiss = useCallback(
    async (appId: string, scope: FeedbackScope, category: string): Promise<boolean> => {
      const key = appId.toLowerCase();
      setDismissedIds((prev) => new Set(prev).add(key));
      try {
        if (scope === 'app') await tauriApi.dismissFeatured(appId, 'app');
        else await tauriApi.dismissFeatured(category, 'category', appId);
        return true;
      } catch {
        setDismissedIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        return false;
      }
    },
    [],
  );

  return { page, loading, failed, reload, dismissedIds, dismiss };
}
