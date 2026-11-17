import React, { createContext, useContext } from 'react';
import type { AppSummary, OAuthUser } from '../types';

/**
 * 跨视图共享的库状态：安装/收藏/关注等成员集合、本地收录与全局平台筛选。
 * App 是唯一提供方；视图经 `useAppContextProps` 读取，不再逐层透传。
 */
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
  onToggleFavorite: (id: string) => void;
  onToggleWatch: (id: string) => void;
  onResetPlatformFilter: () => void;
  onOpenDeveloper: (login: string) => void;
  onOpenAccount: () => void;
}

/** 视图可从上下文取得的全部字段；视图 Props 继承它，显式传入的值优先于上下文。 */
export type AppContextProps = Partial<LibraryState & AppActions>;

const LibraryContext = createContext<Partial<LibraryState>>({});
const AppActionsContext = createContext<Partial<AppActions>>({});

interface AppContextProviderProps {
  library: LibraryState;
  actions: AppActions;
  children: React.ReactNode;
}

/** 库状态与动作分两个上下文：动作引用稳定，仅库状态变化不连带只读动作的消费方。 */
export const AppContextProvider: React.FC<AppContextProviderProps> = ({ library, actions, children }) => (
  <AppActionsContext.Provider value={actions}>
    <LibraryContext.Provider value={library}>{children}</LibraryContext.Provider>
  </AppActionsContext.Provider>
);

/**
 * 以上下文补齐视图 Props：显式传入（非 `undefined`）的字段优先，其余取自上下文。
 * 无提供方时（单测/独立渲染）上下文为空，字段缺席语义与直接传 Props 一致。
 */
export function useAppContextProps<P extends AppContextProps>(props: P): P {
  const library = useContext(LibraryContext);
  const actions = useContext(AppActionsContext);
  const merged: Record<string, unknown> = { ...library, ...actions };
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as P;
}
