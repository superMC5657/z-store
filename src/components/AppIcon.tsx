import React, { useEffect, useRef, useState } from 'react';
import {
  getBufferedIcon,
  getCachedIconDataUri,
  isIconInPreloadBackoff,
  isRemoteHttpIconUrl,
  requestIconLocalCache,
  retryIconFromLocalOrBackend,
  subscribeIconDataReady,
  subscribeIconWrites,
} from '../services/iconStore';
import { normalizeId } from '../services/normalizeId';
import { isRealTauriRuntime } from '../services/tauriRuntime';

interface AppIconProps {
  icon: string;
  name: string;
  appId?: string;
  iconBg?: string;
  className?: string;
  style?: React.CSSProperties;
  size?: number | string;
  iconOverride?: string;
  /** 图标缩放策略：默认 `'cover'` 保持卡片铺满；管理列表可传 `'contain'` 防异形图切边。 */
  fit?: 'cover' | 'contain';
  /** 光学安全区内边距：设置后图片与回退徽章统一内缩为小圆角内块，容器底色透明。 */
  insetPadding?: number | string;
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
  // 裸路径按扩展名收尾判定（忽略 `?` 查询与 `#` 描点），避免类似 `foo.png-evil` 误判。
  const path = value.split(/[?#]/, 1)[0];
  return IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** 按优先级解析有效图标：`iconOverride` > `storeIcon` > `bufferedFirstPaint` > `icon`（空串有效）。 */
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

/** 解析最终可渲染地址：`data:` 或覆写值直显，其余优先读取本地落盘缓存后回落原值。 */
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
  fit = 'cover',
  insetPadding,
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
  const [, setDataTick] = useState(0);
  useEffect(() => {
    const activeTrim = typeof activeIcon === 'string' ? activeIcon.trim() : '';
    const activeLower = activeTrim.toLowerCase();
    return subscribeIconDataReady((keys) => {
      if (
        (appIdNorm && keys.includes(appIdNorm)) ||
        (activeTrim && keys.includes(activeTrim)) ||
        (activeLower && keys.includes(activeLower))
      ) {
        setDataTick((c) => c + 1);
      }
    });
  }, [appIdNorm, activeIcon]);

  const displaySrc = resolveDisplaySrc(activeIcon, iconOverride !== undefined, appIdNorm);

  // 按需触发本地磁盘缓存读取（解除前 30 项预热上限，使任意滚动位置的卡片均能优先走本地缓存）
  useEffect(() => {
    if (iconOverride !== undefined) return;
    if (!activeIcon || displaySrc.startsWith('data:')) return;
    requestIconLocalCache(appIdNorm || undefined, activeIcon);
  }, [appIdNorm, activeIcon, displaySrc, iconOverride]);

  // 判断是否为网络图片 URL（复用模块级唯一谓词，禁止内联重复形状）
  const isUrl = isRemoteIcon(activeIcon);

  // prop 或落盘展示源切换即重置错误态（远端直连失败后一旦本地缓存 data: 就绪立即自愈显示）。
  const [hasError, setHasError] = useState(false);
  // 已完成解码的展示源：与当前 displaySrc 不一致即仍在加载，底下垫首字母占位。
  const [loadedSrc, setLoadedSrc] = useState('');
  const retriedUrlRef = useRef<string>('');
  useEffect(() => {
    retriedUrlRef.current = '';
  }, [activeIcon]);
  useEffect(() => {
    setHasError(false);
  }, [activeIcon, displaySrc]);

  // 真实 Tauri 下远端图标后端单飞：未命中 data: 且后端未处于失败退避时不挂远端 <img>
  // （避免 WebView 与后端双发）；后端失败进入退避后才回退 WebView 直连。
  const realTauri = isRealTauriRuntime();
  const inBackoff = realTauri && isIconInPreloadBackoff(activeIcon);
  // 粘滞记录当前 activeIcon 的后端失败态，避免退避过期后已直连成功的 <img> 被隐藏
  const [backendFailedIcon, setBackendFailedIcon] = useState('');
  useEffect(() => {
    if (inBackoff && backendFailedIcon !== activeIcon) setBackendFailedIcon(activeIcon);
  }, [inBackoff, activeIcon, backendFailedIcon]);
  const backendFailed = inBackoff || (activeIcon !== '' && backendFailedIcon === activeIcon);
  const awaitingBackend =
    realTauri &&
    iconOverride === undefined &&
    isRemoteHttpIconUrl(activeIcon) &&
    !displaySrc.startsWith('data:') &&
    !backendFailed;

  const handleError = () => {
    // 若图片加载失败（网络波动或链接失效），暂降级为首字母徽章，并触发本地磁盘缓存/后端自愈读取
    setHasError(true);
    // 处于后端退避期的直连回退失败时直接定格徽章，避免重复触发后端重试
    if (
      !(realTauri && backendFailed) &&
      !displaySrc.startsWith('data:') &&
      isRemoteIcon(activeIcon) &&
      retriedUrlRef.current !== activeIcon
    ) {
      retriedUrlRef.current = activeIcon;
      retryIconFromLocalOrBackend(appIdNorm || undefined, activeIcon);
    }
  };

  const isImageActive = isUrl && !hasError;
  // 可渲染判定看 displaySrc 本体：activeIcon 为旧 URL 而 displaySrc 被清空/
  // 解析失败置 '' 时，若仍按 activeIcon 渲染 <img src=""> 即永久裂图（hasError 永不置位）。
  const isDisplaySrcRenderable = displaySrc.trim() !== '' && isRemoteIcon(displaySrc);
  const showImg = isImageActive && isDisplaySrcRenderable && !awaitingBackend;
  // 非图即徽章：加载失败、图标为空、地址不可渲染，或轮转覆盖为非图（L5 切空意图）。
  const isFallbackBadge =
    !showImg &&
    !awaitingBackend &&
    ((isUrl && hasError) ||
      !activeIcon ||
      (isUrl && !isDisplaySrcRenderable) ||
      (iconOverride !== undefined && !isUrl));

  const isInset = insetPadding !== undefined;
  const containerStyle: React.CSSProperties = {
    // 内缩模式下底板由外层框提供，回退色改铺在内块上。
    background: isImageActive || isInset ? (style?.background ?? 'transparent') : iconBg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    boxSizing: 'border-box',
    ...(isInset ? { padding: insetPadding } : {}),
    ...(size ? { width: size, height: size } : {}),
    ...style,
  };
  // 内缩模式下徽章与 emoji 与图片同为一块小圆角内块，铺回退色。
  const fallbackTileStyle: React.CSSProperties = isInset
    ? {
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: iconBg,
        borderRadius: 'var(--radius-xs, 4px)',
      }
    : {};
  const badgeTextStyle: React.CSSProperties = {
    // 容器可经 `--app-icon-badge-font` 指定徽章字号（如 AppIconFrame 各档），缺省随容器字号。
    fontSize: 'var(--app-icon-badge-font, 0.45em)',
    fontWeight: 590,
    letterSpacing: '0.5px',
    color: '#ffffff',
    textShadow: '0 1px 2px rgba(0,0,0,0.3)',
    userSelect: 'none',
  };

  // 加载占位：图片解码前或等待后端读盘时垫在底下的首字母块。CSS 延迟淡入
  // （`.app-icon-placeholder`），本地缓存这类瞬时命中不会闪出徽章。
  const placeholder = (
    <span
      className="app-icon-placeholder"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: isInset ? insetPadding : 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: iconBg,
        borderRadius: isInset ? 'var(--radius-xs, 4px)' : 'inherit',
        ...badgeTextStyle,
      }}
    >
      {getInitials(name)}
    </span>
  );

  return (
    <div className={`app-icon-container ${className}`} style={containerStyle}>
      {showImg ? (
        <>
          {loadedSrc !== displaySrc && placeholder}
          <img
            src={displaySrc}
            alt={name}
            className="app-icon-image"
            decoding="async"
            loading={loading}
            onLoad={() => setLoadedSrc(displaySrc)}
            onError={handleError}
            style={{
              // 定位后按文档顺序叠在占位之上
              position: 'relative',
              width: '100%',
              height: '100%',
              objectFit: fit,
              borderRadius: isInset ? 'var(--radius-xs, 4px)' : 'inherit',
              display: 'block',
              opacity: 1,
            }}
          />
        </>
      ) : awaitingBackend ? (
        // 等待后端读盘/下载：本地已落盘约 1ms 即切入 data: 实图，慢时才淡入首字母占位。
        <>
          <span
            className="app-icon-pending"
            aria-hidden="true"
            style={{ ...fallbackTileStyle, background: 'transparent' }}
          />
          {placeholder}
        </>
      ) : isFallbackBadge ? (
        <span className="app-icon-fallback-badge" style={{ ...fallbackTileStyle, ...badgeTextStyle }}>
          {getInitials(name)}
        </span>
      ) : (
        <span className="app-icon-emoji" style={fallbackTileStyle}>
          {activeIcon || '📦'}
        </span>
      )}
    </div>
  );
};
