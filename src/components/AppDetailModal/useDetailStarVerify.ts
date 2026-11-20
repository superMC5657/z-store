import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tauriApi } from '../../services/api';
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
  const { appId, owner, repo, appName, isLoading } = opts;
  const { t } = useTranslation();

  // GitHub 标星态（仅登录可见；后端未就绪时一律按未标星降级）
  const [isStarred, setIsStarred] = useState(false);
  const [isStarring, setIsStarring] = useState(false);

  const isTargetReady = !isLoading && Boolean(owner && repo);

  useEffect(() => {
    let cancelled = false;
    if (!isTargetReady) {
      setIsStarred(false);
      return;
    }
    tauriApi.fetchStarredStatus(appId).then((v) => {
      if (!cancelled) setIsStarred(v);
    }).catch(() => {
      if (!cancelled) setIsStarred(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, owner, repo, isTargetReady]);

  const handleToggleStar = async () => {
    if (!isTargetReady) return;
    if (isStarring) return;
    setIsStarring(true);
    try {
      if (isStarred) {
        await tauriApi.unstarApp(appId);
        setIsStarred(false);
        notifyToast(t('detail.star.unstarred', { name: appName }), 'info');
      } else {
        const res = await tauriApi.starApp(appId);
        setIsStarred(true);
        if (res.warning) {
          notifyToast(res.warning, 'warning');
        } else {
          notifyToast(t('detail.star.starred', { name: appName }), 'success');
        }
      }
    } catch (e) {
      const errStr = String(e);
      if (/(?:请先完成 GitHub 登录|未配置|401)/i.test(errStr)) {
        notifyToast(t('detail.star.login_required'), 'info');
      } else {
        notifyToast(t('detail.star.failed', { error: errStr }), 'error');
      }
    } finally {
      setIsStarring(false);
    }
  };

  return {
    isStarred,
    isStarring,
    handleToggleStar,
  };
}
