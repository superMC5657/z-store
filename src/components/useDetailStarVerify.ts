import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { notifyToast } from '../utils/notify';

/**
 * AppDetailModal 标星关注点 Hook（FR-7）。
 * 已认证蓝标由 catalog 驱动展示（is_verified + VerifiedBadge），不经此 Hook。
 * 纯粹提取原 AppDetailModal.tsx 内联的标星状态及对应处理器。
 * 无任何行为变更；弹窗组件对外属性保持原样。
 */
export function useDetailStarVerify(opts: {
  appId: string;
  owner: string;
  repo: string;
  appName: string;
  oauthLogin?: string | null;
  onRefresh?: (id: string) => void | Promise<unknown>;
}) {
  const { appId, owner, repo, appName } = opts;

  // FR-7: GitHub 标星态（仅登录可见；后端未就绪时一律按未标星降级）
  const [isStarred, setIsStarred] = useState(false);
  const [isStarring, setIsStarring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!owner || owner === '加载中...' || !repo) {
      setIsStarred(false);
      return;
    }
    api.isStarred(appId).then((v) => {
      if (!cancelled) setIsStarred(v);
    }).catch(() => {
      if (!cancelled) setIsStarred(false);
    });
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const handleToggleStar = async () => {
    if (!owner || owner === '加载中...' || !repo) return;
    if (isStarring) return;
    setIsStarring(true);
    try {
      if (isStarred) {
        await api.unstarApp(appId);
        setIsStarred(false);
        notifyToast(`已取消对 ${appName} 的 GitHub 收藏`, 'info');
      } else {
        const res = await api.starApp(appId);
        setIsStarred(true);
        if (res.warning) {
          notifyToast(res.warning, 'warning');
        } else {
          notifyToast(`已在 GitHub 上标星 ${appName}，并存入 z-store-list 列表 ★`, 'success');
        }
      }
    } catch (e) {
      const errStr = String(e);
      if (errStr.includes('请先完成 GitHub 登录') || errStr.includes('未配置') || errStr.includes('401')) {
        notifyToast('请先在「设置」中登录 GitHub 账号，即可使用 GitHub 收藏/标星功能', 'info');
      } else {
        notifyToast(`GitHub 标星失败: ${errStr}`, 'error');
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
