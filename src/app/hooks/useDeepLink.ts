import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import type { ViewType } from '../../types';
import { api } from '../../services/api';

export interface UseDeepLinkParams {
  handleOpenDetail: (id: string) => void;
  handleSearchChange: (q: string) => Promise<void> | void;
  setSelectedDeveloper: (dev: string | null) => void;
  setCurrentView: (view: ViewType) => void;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

export function useDeepLink({
  handleOpenDetail,
  handleSearchChange,
  setSelectedDeveloper,
  setCurrentView,
  showToast,
  t,
}: UseDeepLinkParams) {
  // P0-1 深链安装守卫：`install_app` 深链仅暂存待确认状态——安装必须经由用户显式点击确认方可启动。
  const [pendingDeepLinkInstall, setPendingDeepLinkInstall] = useState<string | null>(null);

  // 深链调度分发器（功能 E）
  const handleDispatchDeepLink = async (rawUrl: string) => {
    try {
      const action = await api.handleDeepLink(rawUrl);
      if (action.action === 'app_detail') {
        handleOpenDetail(action.payload.app_id);
      } else if (action.action === 'install_app') {
        // P0-1: 绝不直接自深链自动安装——打开详情视图并弹出显式确认弹窗；安装仅在用户点击确认后启动。
        handleOpenDetail(action.payload.app_id);
        setPendingDeepLinkInstall(action.payload.app_id);
        showToast(t('toast.deeplink_confirm_notice', { id: action.payload.app_id }), 'warning');
      } else if (action.action === 'search') {
        handleSearchChange(action.payload.query);
      } else if (action.action === 'developer_profile') {
        setSelectedDeveloper(action.payload.owner);
      } else if (action.action === 'open_view') {
        const validViews: ViewType[] = ['home', 'trends', 'categories', 'installed', 'updates', 'favorites', 'settings'];
        if (validViews.includes(action.payload.view as ViewType)) {
          setCurrentView(action.payload.view as ViewType);
        }
      }
      showToast(t('toast.deeplink_responded', { url: rawUrl }), 'info');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  useEffect(() => {
    (window as any).dispatchZStoreDeepLink = handleDispatchDeepLink;

    // 检查 CLI 参数是否带有唤起协议 (如外部双击链接拉起新进程)
    api.getCliDeepLink().then((cliLink) => {
      if (cliLink) {
        handleDispatchDeepLink(cliLink);
      }
    }).catch(() => {});

    return () => {
      delete (window as any).dispatchZStoreDeepLink;
    };
  }, [handleDispatchDeepLink]);

  return {
    pendingDeepLinkInstall,
    setPendingDeepLinkInstall,
    handleDispatchDeepLink,
  };
}
