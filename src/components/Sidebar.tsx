import React from 'react';
import { ViewType } from '../types';

interface SidebarProps {
  currentView: ViewType;
  onSelectView: (view: ViewType) => void;
  installedCount: number;
  hasUpdates: boolean;
  activeMirrorName: string;
  onCycleMirror: () => void;
  isCollapsed?: boolean;
}

interface NavItemConfig {
  id: ViewType;
  label: string;
  group: string;
  icon: React.ReactNode;
  badge?: number | boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  installedCount,
  hasUpdates,
  activeMirrorName,
  onCycleMirror,
  isCollapsed = false,
}) => {
  const navItems: NavItemConfig[] = [
    // Group 1: 发现与探索
    {
      id: 'home',
      label: '精选发现',
      group: '发现与探索',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      ),
    },
    {
      id: 'trends',
      label: '趋势榜单',
      group: '发现与探索',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      ),
    },
    {
      id: 'categories',
      label: '分类浏览',
      group: '发现与探索',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="7" height="7" x="3" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="14" rx="1.5" />
          <rect width="7" height="7" x="3" y="14" rx="1.5" />
        </svg>
      ),
    },

    // Group 2: 应用资产
    {
      id: 'installed',
      label: '已安装应用',
      group: '应用资产',
      badge: installedCount,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m7.5 4.27 9 5.15" />
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      ),
    },
    {
      id: 'updates',
      label: '更新中心',
      group: '应用资产',
      badge: hasUpdates,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 21h5v-5" />
        </svg>
      ),
    },
    {
      id: 'favorites',
      label: '我的收藏',
      group: '应用资产',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
    },

    // Group 3: 偏好与系统
    {
      id: 'settings',
      label: '系统设置',
      group: '偏好与系统',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
    },
  ];

  return (
    <aside
      className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}
      role="navigation"
      aria-label="主要导航"
    >
      {/* Group 1: 发现与探索 */}
      <div className="nav-group-title">发现与探索</div>
      {navItems.slice(0, 3).map((item) => {
        const isSelected = currentView === item.id;
        return (
          <button
            key={item.id}
            className={`nav-item ${isSelected ? 'active' : ''}`}
            onClick={() => onSelectView(item.id)}
            title={isCollapsed ? item.label : undefined}
            aria-label={item.label}
          >
            <span className="nav-icon">
              {item.icon}
            </span>
            <span className="nav-label">{item.label}</span>
          </button>
        );
      })}

      <div className="sidebar-divider" />

      {/* Group 2: 应用资产 */}
      <div className="nav-group-title">应用资产</div>
      {navItems.slice(3, 6).map((item) => {
        const isSelected = currentView === item.id;
        return (
          <button
            key={item.id}
            className={`nav-item ${isSelected ? 'active' : ''}`}
            onClick={() => onSelectView(item.id)}
            title={isCollapsed ? item.label : undefined}
            aria-label={item.label}
          >
            <span className="nav-icon">
              {item.icon}
              {typeof item.badge === 'boolean' && item.badge && (
                <span className="nav-icon-badge-dot" />
              )}
            </span>
            <span className="nav-label">{item.label}</span>

            {typeof item.badge === 'number' && item.badge > 0 && (
              <span className="nav-badge">{item.badge}</span>
            )}
            {typeof item.badge === 'boolean' && item.badge && (
              <span className="nav-badge-dot" />
            )}
          </button>
        );
      })}

      <div className="sidebar-divider" />

      {/* Group 3: 偏好与系统 */}
      <div className="nav-group-title">偏好与系统</div>
      {navItems.slice(6).map((item) => {
        const isSelected = currentView === item.id;
        return (
          <button
            key={item.id}
            className={`nav-item ${isSelected ? 'active' : ''}`}
            onClick={() => onSelectView(item.id)}
            title={isCollapsed ? item.label : undefined}
            aria-label={item.label}
          >
            <span className="nav-icon">
              {item.icon}
            </span>
            <span className="nav-label">{item.label}</span>
          </button>
        );
      })}

      {/* Bottom Network Mirror Status Capsule */}
      <div className="sidebar-footer">
        <button
          className="network-pill"
          onClick={onCycleMirror}
          title={`当前加速节点: ${activeMirrorName} (点击切换)`}
          aria-label={`当前加速节点: ${activeMirrorName}`}
        >
          <span className="status-dot" />
          <span className="network-pill-text">线路: {activeMirrorName}</span>
        </button>
      </div>
    </aside>
  );
};
