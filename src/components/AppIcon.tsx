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
}

// 模块级内存缓存，避免页面切页重新计算与读取
const iconDataCache = new Map<string, string>();
const iconPendingPromises = new Map<string, Promise<string>>();

/**
 * 失效或清空图标内存缓存。
 * 若提供 key，则移除该 key 对应的缓存；若不提供 key，则清空全部内存缓存。
 */
export function invalidateIconCache(key?: string): void {
  if (key) {
    iconDataCache.delete(key);
    iconPendingPromises.delete(key);
  } else {
    iconDataCache.clear();
    iconPendingPromises.clear();
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
    if (!icon || iconDataCache.has(icon) || icon.startsWith('data:')) return;
    if (!isRemoteIcon(icon)) return;

    if (!iconPendingPromises.has(icon)) {
      const p = api
        .getOrFetchIcon(id, icon)
        .then((dataUri) => {
          iconDataCache.set(icon, dataUri);
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
}) => {
  const activeIcon = iconOverride !== undefined ? iconOverride : icon;
  const isDataUri = Boolean(activeIcon && activeIcon.startsWith('data:'));
  const [displaySrc, setDisplaySrc] = useState<string>(() => {
    if (!activeIcon) return '';
    if (isDataUri) return activeIcon;
    if (iconOverride !== undefined) return activeIcon;
    return iconDataCache.get(activeIcon) || activeIcon;
  });
  const [hasError, setHasError] = useState(false);

  // 判断是否为网络图片 URL（复用模块级唯一谓词，禁止内联重复形状）
  const isUrl = isRemoteIcon(activeIcon);

  useEffect(() => {
    setHasError(false);
    if (!activeIcon || !isUrl || isDataUri) {
      setDisplaySrc(activeIcon);
      return;
    }

    // 详情页临时覆盖展示：仅改当前组件实例展示，不回写全局缓存，列表不动
    if (iconOverride !== undefined) {
      let isMounted = true;
      api
        .getOrFetchIcon(appId, activeIcon)
        .then((dataUri) => {
          if (isMounted) {
            setDisplaySrc(dataUri);
            setHasError(false);
          }
        })
        .catch(() => {
          if (isMounted) {
            setDisplaySrc(activeIcon);
          }
        });
      return () => {
        isMounted = false;
      };
    }

    if (iconDataCache.has(activeIcon)) {
      setDisplaySrc(iconDataCache.get(activeIcon)!);
      return;
    }

    let isMounted = true;
    let promise = iconPendingPromises.get(activeIcon);
    if (!promise) {
      promise = api.getOrFetchIcon(appId, activeIcon);
      iconPendingPromises.set(activeIcon, promise);
    }

    promise
      .then((dataUri) => {
        iconDataCache.set(activeIcon, dataUri);
        iconPendingPromises.delete(activeIcon);
        if (isMounted) {
          setDisplaySrc(dataUri);
          setHasError(false);
        }
      })
      .catch(() => {
        iconPendingPromises.delete(activeIcon);
        if (isMounted) {
          setDisplaySrc(activeIcon);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [activeIcon, appId, isUrl, isDataUri, iconOverride]);

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
      {isUrl && !hasError ? (
        <img
          key={displaySrc}
          src={displaySrc}
          alt={name}
          className="app-icon-image"
          decoding="async"
          loading="eager"
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
      ) : (isUrl && hasError) || (iconOverride !== undefined && !isUrl) ? (
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
