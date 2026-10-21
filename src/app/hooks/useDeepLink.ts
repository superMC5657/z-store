import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { tauriApi } from '../../services/api';
import type { Navigate } from '../navigation';

interface UseDeepLinkParams {
  handleOpenDetail: (id: string) => void;
  handleSearchChange: (q: string) => Promise<void> | void;
  setSelectedDeveloper: (dev: string | null) => void;
  /** 集中导航入口（App.createNavigate 产物；合法 ViewType 校验收口于 navigation）。 */
  navigate: Navigate;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/** 全局深链分发器类型（window 挂载点唯一声明处，挂载/卸载见 useDeepLink effect）。 */
declare global {
  interface Window {
    dispatchZStoreDeepLink?: (rawUrl: string) => void;
  }
}

export function useDeepLink({
  handleOpenDetail,
  handleSearchChange,
  setSelectedDeveloper,
  navigate,
  showToast,
  t,
}: UseDeepLinkParams) {
  // 深链安装守卫：`install_app` 深链仅暂存待确认状态——安装必须经由用户显式点击确认方可启动。
  const [stagedDeepLinkInstall, setStagedDeepLinkInstall] = useState<string | null>(null);

  // 深链调度分发器（功能 E）
  const handleDispatchDeepLink = async (rawUrl: string) => {
    try {
      const action = await tauriApi.handleDeepLink(rawUrl);
      if (action.action === 'app_detail') {
        handleOpenDetail(action.payload.app_id);
      } else if (action.action === 'install_app') {
        // 绝不直接自深链自动安装——打开详情视图并弹出显式确认弹窗；安装仅在用户点击确认后启动。
        handleOpenDetail(action.payload.app_id);
        setStagedDeepLinkInstall(action.payload.app_id);
        showToast(t('toast.deeplink_confirm_notice', { id: action.payload.app_id }), 'warning');
      } else if (action.action === 'search') {
        handleSearchChange(action.payload.query);
      } else if (action.action === 'developer_profile') {
        setSelectedDeveloper(action.payload.owner);
      } else if (action.action === 'open_view') {
        // 合法视图校验收口于集中导航（navigation.isViewType）；非法视图静默忽略。
        navigate(action.payload.view);
      }
      showToast(t('toast.deeplink_responded', { url: rawUrl }), 'info');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  useEffect(() => {
    window.dispatchZStoreDeepLink = handleDispatchDeepLink;

    // 检查 CLI 参数是否带有唤起协议 (如外部双击链接拉起新进程)
    tauriApi.getCliDeepLink().then((cliLink) => {
      if (cliLink) {
        handleDispatchDeepLink(cliLink);
      }
    }).catch(() => {});

    return () => {
      delete window.dispatchZStoreDeepLink;
    };
  }, [handleDispatchDeepLink]);

  return {
    stagedDeepLinkInstall,
    setStagedDeepLinkInstall,
    handleDispatchDeepLink,
  };
}
