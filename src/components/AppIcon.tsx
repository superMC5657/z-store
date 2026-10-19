import React, { useEffect, useState } from 'react';
import {
  getBufferedIcon,
  getCachedIconDataUri,
  subscribeIconWrites,
} from '../services/iconStore';
import { normalizeId } from '../services/normalizeId';

interface AppIconProps {
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

/** 可直接展示的图片扩展名（裸路径用；`http(s)`/`data:` 另由前缀判定，不在此列）。 */
const IMAGE_EXTENSIONS = ['.png', '.svg', '.jpg', '.webp', '.ico'];

// 唯一的远端图标判定谓词：调用方（`services/iconStore.queueIconFetches` 内部与组件本体）必须复用此函数，禁止各自内联重复形状。
export function isRemoteIcon(icon: string | undefined | null): boolean {
  if (!icon) return false;
  const value = icon.trim().toLowerCase();
  if (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('data:')
  ) {
    return true;
  }
  // 裸路径按扩展名收尾判定（忽略 `?` 查询与 `#` 描点）；`foo.png-evil` 之类不再误判。
  const path = value.split(/[?#]/, 1)[0];
  return IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * 有效图标优先级：`iconOverride`（详情轮转即时态）优先于一切，其次读侧扇出
 * `storeIcon`，再次 M1 缓冲首绘，最后回落父 prop。空（`''`）亦为有效值，
 * 恒覆盖旧值（防复活旧图），故一律按 `undefined` 判空。
 */
export function resolveActiveIcon(
  iconOverride: string | undefined,
  storeIcon: string | undefined,
  bufferedFirstPaint: string | undefined,
  icon: string,
): string {
  if (iconOverride !== undefined) return iconOverride;
  if (storeIcon !== undefined) return storeIcon;
  if (bufferedFirstPaint !== undefined) return bufferedFirstPaint;
  return icon;
}

/**
 * 可渲染地址：空恒空（徽章）；`data:` 与 `iconOverride` 直显；
 * 否则按 URL 键、归一 id 键双查落盘 `data:` 缓存，皆无则回落原值。
 */
export function resolveDisplaySrc(
  activeIcon: string,
  hasIconOverride: boolean,
  appIdNorm: string,
): string {
  if (!activeIcon) return '';
  if (activeIcon.startsWith('data:')) return activeIcon;
  if (hasIconOverride) return activeIcon;
  const fromUrlCache = getCachedIconDataUri(activeIcon);
  if (fromUrlCache) return fromUrlCache;
  const fromIdCache = appIdNorm ? getCachedIconDataUri(appIdNorm) : undefined;
  return fromIdCache ?? activeIcon;
}

// 首字母缩写徽章（如 RustDesk -> RD，LocalSend -> LS）。
export function getInitials(name: string): string {
  const clean = name.replace(/[^\w\s\u4e00-\u9fa5]/g, '').trim();
  if (!clean) return '📦';
  const words = clean.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const camelParts = clean.match(/[A-Z][a-z0-9]*/g);
  if (camelParts && camelParts.length >= 2) {
    return (camelParts[0][0] + camelParts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
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
  // 图标读侧订阅：店内 `admitIconHit` 受理后经 `subscribeIconWrites` 扇出，
  // 本组件经 `appId` 归一（`normalizeId`）跟进同键写（覆盖父 prop 迟到/stale）。
  const appIdNorm = typeof appId === 'string' ? normalizeId(appId) : '';
  const [storeIcon, setStoreIcon] = useState<string | undefined>(undefined);
  useEffect(() => {
    setStoreIcon(undefined);
  }, [appIdNorm]);
  useEffect(() => {
    if (!appIdNorm) return;
    return subscribeIconWrites(({ targets, icon: nextIcon }) => {
      if (targets.includes(appIdNorm)) {
        setStoreIcon(nextIcon);
      }
    });
  }, [appIdNorm]);

  const bufferedFirstPaint = appIdNorm ? getBufferedIcon(appIdNorm) : undefined;
  const activeIcon = resolveActiveIcon(iconOverride, storeIcon, bufferedFirstPaint, icon);
  const displaySrc = resolveDisplaySrc(activeIcon, iconOverride !== undefined, appIdNorm);

  // 判断是否为网络图片 URL（复用模块级唯一谓词，禁止内联重复形状）
  const isUrl = isRemoteIcon(activeIcon);

  // prop 切换即重置错误态（展示走渲染期直算，无 IPC 副作用）。
  const [hasError, setHasError] = useState(false);
  useEffect(() => {
    setHasError(false);
  }, [activeIcon]);

  const handleError = () => {
    // 若图片加载失败（网络不可达或链接失效），平滑降级为首字母徽章
    setHasError(true);
  };

  const isImageActive = isUrl && !hasError;
  // 可渲染判定看 displaySrc 本体：activeIcon 为旧 URL 而 displaySrc 被清空/
  // 解析失败置 '' 时，若仍按 activeIcon 渲染 <img src=""> 即永久裂图（hasError 永不置位）。
  const isDisplaySrcRenderable = displaySrc.trim() !== '' && isRemoteIcon(displaySrc);
  const showImg = isImageActive && isDisplaySrcRenderable;
  // 非图即徽章：加载失败、图标为空、地址不可渲染，或轮转覆盖为非图（L5 切空意图）。
  const isFallbackBadge =
    !showImg &&
    ((isUrl && hasError) ||
      !activeIcon ||
      (isUrl && !isDisplaySrcRenderable) ||
      (iconOverride !== undefined && !isUrl));

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
      ) : isFallbackBadge ? (
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
