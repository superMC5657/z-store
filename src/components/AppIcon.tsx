import React, { useEffect, useState } from 'react';
import { api } from '../services/api';

export interface AppIconProps {
  icon: string;
  name: string;
  appId?: string;
  iconBg?: string;
  className?: string;
  style?: React.CSSProperties;
  size?: number | string;
  iconOverride?: string;
  /** 首屏以上 eager，其余一律 lazy（默认 lazy，避免全网格同时抢带宽）。 */
  loading?: 'eager' | 'lazy';
}

// 模块级内存缓存，避免页面切页重新计算与读取
const iconDataCache = new Map<string, string>();
const iconPendingPromises = new Map<string, Promise<string>>();
const appIdToIconMap = new Map<string, string>();

/**
 * 失效或清空图标内存缓存。
 * 若提供 key（appId 或 icon URL），则移除该 key 及其对应映射的缓存；若不提供 key，则清空全部内存缓存。
 */
export function invalidateIconCache(key?: string): void {
  if (key) {
    iconDataCache.delete(key);
    iconPendingPromises.delete(key);
    const mappedIcon = appIdToIconMap.get(key);
    if (mappedIcon) {
      iconDataCache.delete(mappedIcon);
      iconPendingPromises.delete(mappedIcon);
      appIdToIconMap.delete(key);
    }
    for (const [id, url] of appIdToIconMap.entries()) {
      if (url === key) {
        iconDataCache.delete(id);
        iconPendingPromises.delete(id);
        appIdToIconMap.delete(id);
      }
    }
  } else {
    iconDataCache.clear();
    iconPendingPromises.clear();
    appIdToIconMap.clear();
  }
}

// 唯一的远端图标判定谓词：调用方（preloadIcons 与组件本体）必须复用此函数，禁止各自内联重复形状
export function isRemoteIcon(icon: string | undefined | null): boolean {
  if (!icon) return false;
  return (
    icon.startsWith('http://') ||
    icon.startsWith('https://') ||
    icon.startsWith('data:') ||
    icon.includes('.png') ||
    icon.includes('.svg') ||
    icon.includes('.jpg') ||
    icon.includes('.webp') ||
    icon.includes('.ico')
  );
}

export function preloadIcons(items: (string | { id?: string; icon: string })[]) {
  if (typeof window === 'undefined') return;
  items.forEach((item) => {
    const icon = typeof item === 'string' ? item : item.icon;
    const id = typeof item === 'string' ? undefined : item.id;
    if(!icon||iconDataCache.has(icon)||icon.startsWith('data:'))return;
    if (!isRemoteIcon(icon)) return;

    if (!iconPendingPromises.has(icon)) {
      const p = api
        .getOrFetchIcon(id, icon)
        .then((dataUri) => {
          iconDataCache.set(icon, dataUri);
          if (id) {
            appIdToIconMap.set(id, icon);
            appIdToIconMap.set(id.toLowerCase(), icon);
            iconDataCache.set(id, dataUri);
            iconDataCache.set(id.toLowerCase(), dataUri);
          }
          iconPendingPromises.delete(icon);
          return dataUri;
        })
        .catch((err) => {
          iconPendingPromises.delete(icon);
          throw err;
        });
      iconPendingPromises.set(icon, p);
    }
  });
}

export const AppIcon: React.FC<AppIconProps> = ({
  icon,
  name,
  appId,
  iconBg = 'linear-gradient(135deg, #0284c7, #0369a1)',
  className = '',
  style = {},
  size,
  iconOverride,
  loading = 'lazy',
}) => {
  // `appId` 仅为调用方 key 透传（店内 `applyHit` 别名归一用），本组件不凭它回读/请求。
  void appId;
  // C1 读透适配（薄）：level 单调由店内 `applyHit` 保证，此处不判 level；列表空壳补齐经上游
  // `assembleOnlineRowsWithIcons`/`stickyIconFor`（`getBufferedIcon` 唯一口），
  // 本组件只按 `icon` prop 展示（空即徽章）——写口唯一在店内 `applyHit`（`invalidate→preload→patch`），
  // 此处不自发 IPC、不订阅窗口总线（`zstore:icon-changed` 已删，见 09 收敛）。
  const rawActiveIcon = iconOverride !== undefined ? iconOverride : icon;
  const activeIcon=rawActiveIcon;
  const isDataUri = Boolean(activeIcon && activeIcon.startsWith('data:'));
  const [hasError, setHasError] = useState(false);
  // 只读展示：同 URL 的 data URI 缓存命中即直显（preload 落盘后的内存态），否则直显 prop；
  // 空 prop 恒徽章（不回读 appId 旧缓存，防 L5 清零后复活旧图）。
  const displaySrc = (() => {
    if (!activeIcon) return '';
    if (isDataUri) return activeIcon;
    if (iconOverride !== undefined) return activeIcon;
    const fromCache = iconDataCache.get(activeIcon);
    if (fromCache) return fromCache;
    return activeIcon;
  })();

  // 判断是否为网络图片 URL（复用模块级唯一谓词，禁止内联重复形状）
  const isUrl = isRemoteIcon(activeIcon);

  // prop 切换即重置错误态（展示走渲染期直算，无 IPC 副作用）。
  useEffect(() => {
    setHasError(false);
  }, [activeIcon]);

  const handleError = () => {
    // 若图片加载失败（网络不可达或链接失效），平滑降级为首字母徽章
    setHasError(true);
  };

  // 生成首字母缩写徽章（如 RustDesk -> RD，LocalSend -> LS）
  const getInitials = (str: string) => {
    const clean = str.replace(/[^\w\s\u4e00-\u9fa5]/g, '').trim();
    if (!clean) return '📦';
    const words = clean.split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    const camelParts = clean.match(/[A-Z][a-z0-9]*/g);
    if (camelParts && camelParts.length >= 2) {
      return (camelParts[0][0] + camelParts[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
  };

  const isImageActive = isUrl && !hasError;
  // 可渲染判定必须看 displaySrc 本体：activeIcon 为旧 URL 而 displaySrc 被 L5 清空/
  // 解析失败置 '' 时，若仍按 activeIcon 渲染 <img src=""> 即永久裂图（hasError 永不置位）。
  const isDisplaySrcRenderable = displaySrc.trim() !== '' && isRemoteIcon(displaySrc);
  const showImg = isImageActive && isDisplaySrcRenderable;

  const containerStyle: React.CSSProperties = {
    background: isImageActive ? (style?.background ?? 'transparent') : iconBg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    ...(size ? { width: size, height: size } : {}),
    ...style,
  };

  return (
    <div className={`app-icon-container ${className}`} style={containerStyle}>
      {showImg ? (
        <img
          src={displaySrc}
          alt={name}
          className="app-icon-image"
          decoding="async"
          loading={loading}
          onError={handleError}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: 'inherit',
            display: 'block',
            opacity: 1,
          }}
        />
      ) : (isUrl && hasError) || !activeIcon || (isUrl && !isDisplaySrcRenderable) || (iconOverride !== undefined && !isUrl) ? (
        <span
          className="app-icon-fallback-badge"
          style={{
            fontSize: '0.45em',
            fontWeight: 590,
            letterSpacing: '0.5px',
            color: '#ffffff',
            textShadow: '0 1px 2px rgba(0,0,0,0.3)',
            userSelect: 'none',
          }}
        >
          {getInitials(name)}
        </span>
      ) : (
        <span className="app-icon-emoji">{activeIcon || '📦'}</span>
      )}
    </div>
  );
};
