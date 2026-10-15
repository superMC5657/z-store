import React, { useEffect, useState } from 'react';
import {
  getBufferedIcon,
  getCachedIconDataUri,
  subscribeIconWrites,
} from '../services/iconStore';
import { normalizeId } from '../services/normalizeId';

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

// 唯一的远端图标判定谓词：调用方（`services/iconStore.queueIconFetches` 内部与组件本体）必须复用此函数，禁止各自内联重复形状
// 备注：此为展示判定（含 `.png/.svg` 后缀直显），与店内 `isRemoteHttpIconUrl` 落盘门控正交（仅 `http(s)` 落盘），非重复 locality。
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
  // 图标深 module 订阅（读侧）：店内 `admitIconHit` 唯一写口受理后经 `subscribeIconWrites` 扇出，
  // 本组件经 `appId` 归一（`normalizeId`，遵 ADR-0010）跟进同键写——覆盖父 prop 迟到/stale 情形
  // （如详情轮转切 L5 只调 `admitIconHit` 不带 patch，父列表经 App 侧扇出跟进，本组件经此跟进单卡）。
  // 空（`''`/L5）恒覆盖旧 prop（防复活旧图）；实图覆盖空/旧 prop（迟到 `icon-ready` 先展）。
  // `iconOverride`（详情轮转即时态）优先于一切，不被扇出覆盖。
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
      } else {
        // 别名归一兜底：`id` 单一规范字段已在店内归一为 targets，跨键（坐标 vs id）已覆盖。
      }
    });
  }, [appIdNorm]);
  // M1 缓冲首绘回读 + 盘 dataUri 直显（只读，不自发 IPC）：
  // storeIcon（扇出即时态）优先，其次 M1 缓冲（getBufferedIcon 唯一口，迟到 icon-ready 首绘即对），
  // 最后回落父 prop；空（`''`/L5）恒徽章（不回读旧缓存，防复活旧图，见 `HomeView.search-icon` 回归线）。
  // level 单调由店内 `admitIconHit` 保证，此处不判 level；列表空壳补齐经上游
  // `assembleOnlineRowsWithIcons`/`resolveIconWithBuffer`（店内唯一口），
  // 本组件只按 resolved 图标展示（空即徽章）——写口唯一在店内 `admitIconHit`（`invalidate→queue→patch`），
  // 此处不自发 IPC、不订阅窗口总线。
  // 首绘回读经 `getBufferedIcon` 同步读 M1，盘 dataUri 经 `getCachedIconDataUri` 同步读内存态（入队落盘后），
  // 二者均为同步内存读，无 IPC 副作用。
  const bufferedFirstPaint = appIdNorm ? getBufferedIcon(appIdNorm) : undefined;
  const rawActiveIcon =
    iconOverride !== undefined
      ? iconOverride
      : storeIcon !== undefined
        ? storeIcon
        : bufferedFirstPaint !== undefined
          ? bufferedFirstPaint
          : icon;
  const activeIcon=rawActiveIcon;
  const isDataUri = Boolean(activeIcon && activeIcon.startsWith('data:'));
  const [hasError, setHasError] = useState(false);
  // 只读展示：同 URL 的 data URI 缓存命中即直显（店内 `getCachedIconDataUri` 唯一口，
  // 入队落盘后的内存态），否则直显 prop；
  // L5 清零（`storeIcon === ''` 或首绘空）恒徽章（不回读旧缓存，防复活旧图）。
  // 盘 dataUri 双键回读：先按 URL 键，再按归一 id 键（入队按 id 亦存一份，首绘即对）。
  const displaySrc = (() => {
    if (!activeIcon) return '';
    if (isDataUri) return activeIcon;
    if (iconOverride !== undefined) return activeIcon;
    const fromCache = getCachedIconDataUri(activeIcon);
    if (fromCache) return fromCache;
    const fromIdCache = appIdNorm ? getCachedIconDataUri(appIdNorm) : undefined;
    if (fromIdCache) return fromIdCache;
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
