import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { WatchDismissedEntry, WatchUpdatedPayload } from '../../types';
import { tauriApi } from '../../services/api';
import { normalizeId } from '../../services/normalizeId';
import { listenWindowEvent, newMountCtx, releaseMountCtx, trackSubscription, useLatestRef } from './mountCtx';

interface UseWatchStateParams {
  isRulesModalOpen: boolean;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/** 关注订阅状态管理：维护关注集合、待处理/已读提醒列表及事件订阅。 */
export function useWatchState({ isRulesModalOpen, showToast, t }: UseWatchStateParams) {
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());
  const [watchNotifications, setWatchNotifications] = useState<WatchUpdatedPayload[]>([]);
  const [dismissedWatches, setDismissedWatches] = useState<WatchDismissedEntry[]>([]);

  const watchedRef = useLatestRef(watchedIds);
  const showToastRef = useLatestRef(showToast);
  const tRef = useLatestRef(t);
  const checkingWatchedRef = useRef(false);
  const watchAutoCheckedRef = useRef(false);

  const refreshDismissedWatches = useCallback(async () => {
    try {
      const rows = await tauriApi.getDismissedWatchNotifications();
      setDismissedWatches(Array.isArray(rows) ? rows : []);
    } catch {
      // 读失败保留现有列表
    }
  }, []);

  useEffect(() => {
    const ctx = newMountCtx();
    tauriApi
      .getWatchedApps()
      .then((entries) => {
        if (!ctx.mounted) return;
        const ids = (Array.isArray(entries) ? entries : []).map((e) => e.app_id);
        setWatchedIds(new Set(ids));
      })
      .catch(() => {});
    tauriApi
      .getWatchNotifications()
      .then((pending) => {
        if (!ctx.mounted || !Array.isArray(pending)) return;
        // 读回期间已到达的实时提醒优先（同应用取较新的一条）
        setWatchNotifications((prev) => {
          const live = new Set(prev.map((n) => n.app_id));
          return [...prev, ...pending.filter((n) => !live.has(n.app_id))];
        });
      })
      .catch(() => {});
    trackSubscription(
      ctx,
      tauriApi.onWatchUpdated((payload) => {
        if (!ctx.mounted) return;
        const label = payload.app_name || payload.app_id;
        showToastRef.current(
          tRef.current('toast.watch_update_released', { name: label, version: payload.version }),
          'info',
        );
        setWatchNotifications((prev) => [payload, ...prev.filter((n) => n.app_id !== payload.app_id)]);
      }),
    );

    const handleDataImported = async () => {
      try {
        const entries = await tauriApi.getWatchedApps().catch(() => [] as { app_id: string }[]);
        if (!ctx.mounted) return;
        const ids = (Array.isArray(entries) ? entries : []).map((w) => w.app_id);
        setWatchedIds(new Set(ids));
      } catch {
        // 忽略：后端未就绪时保持现状
      }
    };
    listenWindowEvent(ctx, 'zstore:data-imported', handleDataImported);
    void refreshDismissedWatches();

    return () => {
      releaseMountCtx(ctx);
    };
  }, [refreshDismissedWatches]);

  useEffect(() => {
    if (isRulesModalOpen) void refreshDismissedWatches();
  }, [isRulesModalOpen, refreshDismissedWatches]);

  const handleToggleWatch = useCallback(
    async (id: string) => {
      const key = normalizeId(id);
      if (!key) return;
      const isWatched = watchedRef.current.has(key);
      try {
        if (isWatched) {
          await tauriApi.unwatchApp(key);
        } else {
          await tauriApi.watchApp(key);
        }
      } catch (e) {
        showToastRef.current(tRef.current('toast.watch_failed', { error: String(e) }), 'error');
        return;
      }
      setWatchedIds((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
          showToastRef.current(tRef.current('toast.watch_unfollowed'), 'info');
        } else {
          next.add(key);
          showToastRef.current(tRef.current('toast.watch_followed'), 'success');
        }
        return next;
      });
      if (isWatched) {
        setWatchNotifications((prev) => prev.filter((n) => normalizeId(n.app_id) !== key));
        void refreshDismissedWatches();
      } else {
        watchAutoCheckedRef.current = false;
      }
    },
    [refreshDismissedWatches],
  );

  const handleEnterWatchedTab = useCallback(async () => {
    if (checkingWatchedRef.current || watchAutoCheckedRef.current || watchedRef.current.size === 0) return;
    watchAutoCheckedRef.current = true;
    checkingWatchedRef.current = true;
    try {
      const pending = await tauriApi.checkWatchedUpdates(true);
      if (Array.isArray(pending)) setWatchNotifications(pending);
      void refreshDismissedWatches();
    } catch {
      watchAutoCheckedRef.current = false;
    } finally {
      checkingWatchedRef.current = false;
    }
  }, [refreshDismissedWatches]);

  const handleDismissWatchNotification = useCallback(
    async (appId: string) => {
      try {
        await tauriApi.dismissWatchNotification(appId);
      } catch (e) {
        showToastRef.current(tRef.current('toast.watch_failed', { error: String(e) }), 'error');
        return;
      }
      setWatchNotifications((prev) => prev.filter((n) => n.app_id !== appId));
      void refreshDismissedWatches();
    },
    [refreshDismissedWatches],
  );

  const handleRestoreWatchNotification = useCallback(
    async (appId: string) => {
      await tauriApi.restoreWatchNotification(appId);
      const [pending] = await Promise.all([
        tauriApi.getWatchNotifications().catch(() => null),
        refreshDismissedWatches(),
      ]);
      if (Array.isArray(pending)) setWatchNotifications(pending);
    },
    [refreshDismissedWatches],
  );

  // 同一应用的待处理提醒与已读记录互斥：新版本到来即令其已读记录失效
  const activeDismissedWatches = useMemo(() => {
    if (watchNotifications.length === 0) return dismissedWatches;
    const pendingIds = new Set(watchNotifications.map((n) => normalizeId(n.app_id)));
    return dismissedWatches.filter((d) => !pendingIds.has(normalizeId(d.app_id)));
  }, [dismissedWatches, watchNotifications]);

  return {
    watchedIds,
    watchNotifications,
    activeDismissedWatches,
    handleToggleWatch,
    handleEnterWatchedTab,
    handleDismissWatchNotification,
    handleRestoreWatchNotification,
  };
}
