import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tauriApi } from '../../services/api';
import { normalizeId } from '../../services/normalizeId';
import { notifyToast } from '../../useToasts';

/** AppDetailModal 标星 Hook：维护当前应用的 GitHub 标星状态与切换操作。 */
export function useDetailStarVerify(opts: {
  appId: string;
  owner: string;
  repo: string;
  appName: string;
  oauthLogin?: string | null;
  onRefresh?: (id: string) => void | Promise<unknown>;
  isLoading?: boolean;
}) {
  const { appId, owner, repo, appName, oauthLogin, isLoading } = opts;
  const { t } = useTranslation();

  // GitHub 标星态（仅登录可见；后端未就绪时一律按未标星降级）
  const [isStarred, setIsStarred] = useState(false);
  const [isStarring, setIsStarring] = useState(false);
  const currentAppIdRef = useRef(normalizeId(appId));
  currentAppIdRef.current = normalizeId(appId);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isTargetReady = !isLoading && Boolean(owner && repo);

  useEffect(() => {
    let cancelled = false;
    const reqAppId = normalizeId(appId);
    setIsStarred(false);
    setIsStarring(false);
    if (!isTargetReady) {
      return;
    }
    tauriApi.fetchStarredStatus(appId).then((v) => {
      if (!cancelled && isMountedRef.current && currentAppIdRef.current === reqAppId) {
        setIsStarred(v);
      }
    }).catch(() => {
      if (!cancelled && isMountedRef.current && currentAppIdRef.current === reqAppId) {
        setIsStarred(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [appId, owner, repo, isTargetReady, oauthLogin]);

  const handleToggleStar = async () => {
    if (!isTargetReady) return;
    if (isStarring) return;
    const reqAppId = normalizeId(appId);
    const rawAppId = appId;
    const targetName = appName;
    const wasStarred = isStarred;
    setIsStarring(true);
    try {
      if (wasStarred) {
        await tauriApi.unstarApp(rawAppId);
        if (!isMountedRef.current || currentAppIdRef.current !== reqAppId) return;
        setIsStarred(false);
        notifyToast(t('detail.star.unstarred', { name: targetName }), 'info');
      } else {
        const res = await tauriApi.starApp(rawAppId);
        if (!isMountedRef.current || currentAppIdRef.current !== reqAppId) return;
        setIsStarred(true);
        if (res.warning) {
          notifyToast(res.warning, 'warning');
        } else {
          notifyToast(t('detail.star.starred', { name: targetName }), 'success');
        }
      }
    } catch (e) {
      if (!isMountedRef.current || currentAppIdRef.current !== reqAppId) return;
      const errStr = String(e);
      if (/(?:请先完成 GitHub 登录|未配置|401)/i.test(errStr)) {
        notifyToast(t('detail.star.login_required'), 'info');
      } else {
        notifyToast(t('detail.star.failed', { error: errStr }), 'error');
      }
    } finally {
      if (isMountedRef.current && currentAppIdRef.current === reqAppId) {
        setIsStarring(false);
      }
    }
  };

  return {
    isStarred,
    isStarring,
    handleToggleStar,
  };
}
