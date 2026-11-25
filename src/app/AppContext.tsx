import React, { createContext, useContext, useMemo } from 'react';
import type { AppSummary, OAuthUser, ViewType } from '../types';
import type { PlatformCounts } from './selectors';

/** 跨视图共享的库状态，由 App 统一提供、视图通过 `useAppContextProps` 读取。 */
export interface LibraryState {
  installedIds: Set<string>;
  installingIds: Set<string>;
  /** 已纳管集合；`null` = managed 未加载（已安装命中行占位）。 */
  managedIds: Set<string> | null;
  favoriteIds: Set<string>;
  watchedIds: Set<string>;
  /** custom 草稿已存在 id 集（归一小写），供富卡隐藏已存在的移入入口；不参与黄标判定。 */
  customIds: ReadonlySet<string>;
  /** 本地收录全量：黄标唯一来源。 */
  localApps: readonly AppSummary[];
  /** 已确认 other 的 id 集：空平台行据此区分 other 与加载中。 */
  platformResolvedOtherIds: ReadonlySet<string>;
  /** 全局设备平台选择。 */
  selectedPlatforms: ReadonlySet<string>;
  oauthUser: OAuthUser | null;
}

/** 跨视图共享的动作回调（App 侧保持引用稳定，供 memo 卡片复用）。 */
export interface AppActions {
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string, options?: { silent?: boolean }) => Promise<boolean> | boolean | void;
  onToggleWatch: (id: string) => void;
  onResetPlatformFilter: () => void;
  onOpenDeveloper: (login: string) => void;
  onOpenAccount: () => void;
}

/** 视图可从上下文取得的全部字段；视图 Props 继承它，显式传入的值优先于上下文。 */
export type AppContextProps = Partial<LibraryState & AppActions>;

const AppContext = createContext<AppContextProps>({});

/** 视图侧栏平台分布上报通道（按视图键写入 App 级槽位）。 */
export type PlatformCountsReporter = (view: ViewType, counts: PlatformCounts | null) => void;
const PlatformCountsReporterContext = createContext<PlatformCountsReporter | undefined>(undefined);

/** 读取侧栏平台分布上报通道；Provider 缺席（孤立组件渲染）时为 undefined。 */
export function usePlatformCountsReporter(): PlatformCountsReporter | undefined {
  return useContext(PlatformCountsReporterContext);
}

interface AppContextProviderProps {
  library: LibraryState;
  actions: AppActions;
  reportPlatformCounts?: PlatformCountsReporter;
  children: React.ReactNode;
}

/** 向各视图统一提供共享库状态、动作回调与侧栏平台分布上报通道。 */
export const AppContextProvider: React.FC<AppContextProviderProps> = ({
  library,
  actions,
  reportPlatformCounts,
  children,
}) => {
  const value = useMemo<AppContextProps>(() => ({ ...library, ...actions }), [library, actions]);
  return (
    <AppContext.Provider value={value}>
      <PlatformCountsReporterContext.Provider value={reportPlatformCounts}>
        {children}
      </PlatformCountsReporterContext.Provider>
    </AppContext.Provider>
  );
};

/** 以上下文补齐视图 Props：显式传入的值优先，其余取自上下文。 */
export function useAppContextProps<P extends AppContextProps>(props: P): P {
  const ctx = useContext(AppContext);
  const merged: Record<string, unknown> = { ...ctx };
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as P;
}
