import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { notifyToast } from '../utils/notify';

/**
 * AppDetailModal 标星与所有权校验关注点 Hook（FR-7 / FR-8.3）。
 * 纯粹提取原 AppDetailModal.tsx 内联的标星状态、所有者检测、校验码提交状态及对应处理器。
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
  const { appId, owner, repo, appName, oauthLogin, onRefresh } = opts;

  // FR-7: GitHub 标星态（仅登录可见；后端未就绪时一律按未标星降级）
  const [isStarred, setIsStarred] = useState(false);
  const [isStarring, setIsStarring] = useState(false);
  // FR-8.3: 所有权校验码提交态（MVP：README 子串命中即通过）
  const [verifyCode, setVerifyCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [showVerifySection, setShowVerifySection] = useState(false);

  const isOwner = useMemo(() => {
    if (!oauthLogin || !owner) return false;
    return oauthLogin.toLowerCase() === owner.toLowerCase();
  }, [oauthLogin, owner]);

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

  // FR-8.3: 提交所有权校验码 → 通过后刷新详情点亮勋章
  const handleVerifyOwnership = async () => {
    const code = verifyCode.trim();
    if (!code || isVerifying) return;
    setIsVerifying(true);
    try {
      const ok = await api.verifyOwnership(appId, code);
      if (ok) {
        notifyToast(`所有权验证通过，${appName} 已颁发认证勋章`, 'success');
        setVerifyCode('');
        setShowVerifySection(false);
        if (onRefresh) await onRefresh(appId);
      } else {
        notifyToast('校验码未命中：请确认已将其写入仓库 README', 'error');
      }
    } catch (e) {
      notifyToast(`验证失败: ${String(e)}`, 'error');
    } finally {
      setIsVerifying(false);
    }
  };

  useEffect(() => {
    setVerifyCode('');
    setShowVerifySection(false);
  }, [appId]);

  return {
    isOwner,
    isStarred,
    isStarring,
    verifyCode,
    setVerifyCode,
    isVerifying,
    showVerifySection,
    setShowVerifySection,
    handleToggleStar,
    handleVerifyOwnership,
  };
}
