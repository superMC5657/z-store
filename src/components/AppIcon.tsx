import React, { useEffect, useState } from 'react';
import { api } from '../services/api';

interface AppIconProps {
  icon: string;
  name: string;
  appId?: string;
  owner?: string;
  repo?: string;
  iconBg?: string;
  className?: string;
  style?: React.CSSProperties;
  size?: number | string;
}

// 模块级内存缓存，避免页面切页重新计算与读取
const iconDataCache = new Map<string, string>();
const iconPendingPromises = new Map<string, Promise<string>>();

export function preloadIcons(
  items: (string | { id?: string; owner?: string; repo?: string; icon: string })[]
) {
  if (typeof window === 'undefined') return;
  items.forEach((item) => {
    const icon = typeof item === 'string' ? item : item.icon;
    const id = typeof item === 'string' ? undefined : item.id;
    const owner = typeof item === 'string' ? undefined : item.owner;
    const repo = typeof item === 'string' ? undefined : item.repo;
    if (!icon || iconDataCache.has(icon) || icon.startsWith('data:')) return;
    const isUrl =
      icon.startsWith('http://') ||
      icon.startsWith('https://') ||
      icon.includes('.png') ||
      icon.includes('.svg');
    if (!isUrl) return;

    if (!iconPendingPromises.has(icon)) {
      const p = api
        .getOrFetchIcon(owner, repo, id, icon)
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
  owner,
  repo,
  iconBg = 'linear-gradient(135deg, #0284c7, #0369a1)',
  className = '',
  style = {},
  size,
}) => {
  const isDataUri = Boolean(icon && icon.startsWith('data:'));
  const [displaySrc, setDisplaySrc] = useState<string>(() => {
    if (!icon) return '';
    if (isDataUri) return icon;
    return iconDataCache.get(icon) || icon;
  });
  const [hasError, setHasError] = useState(false);

  // 判断是否为网络图片 URL
  const isUrl = Boolean(
    icon &&
      (icon.startsWith('http://') ||
        icon.startsWith('https://') ||
        icon.startsWith('data:') ||
        icon.includes('.png') ||
        icon.includes('.svg') ||
        icon.includes('.jpg') ||
        icon.includes('.webp') ||
        icon.includes('.ico'))
  );

  useEffect(() => {
    if (!icon || !isUrl || isDataUri) {
      setDisplaySrc(icon);
      return;
    }
    if (iconDataCache.has(icon)) {
      setDisplaySrc(iconDataCache.get(icon)!);
      return;
    }

    let isMounted = true;
    let promise = iconPendingPromises.get(icon);
    if (!promise) {
      promise = api.getOrFetchIcon(owner, repo, appId, icon);
      iconPendingPromises.set(icon, promise);
    }

    promise
      .then((dataUri) => {
        iconDataCache.set(icon, dataUri);
        iconPendingPromises.delete(icon);
        if (isMounted) {
          setDisplaySrc(dataUri);
        }
      })
      .catch(() => {
        iconPendingPromises.delete(icon);
        if (isMounted) {
          setDisplaySrc(icon);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [icon, appId, isUrl, isDataUri]);

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
      ) : isUrl && hasError ? (
        <span
          className="app-icon-fallback-badge"
          style={{
            fontSize: '0.45em',
            fontWeight: 800,
            letterSpacing: '0.5px',
            color: '#ffffff',
            textShadow: '0 1px 2px rgba(0,0,0,0.3)',
            userSelect: 'none',
          }}
        >
          {getInitials(name)}
        </span>
      ) : (
        <span className="app-icon-emoji">{icon || '📦'}</span>
      )}
    </div>
  );
};
