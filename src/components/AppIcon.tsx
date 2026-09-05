import React, { useState } from 'react';

interface AppIconProps {
  icon: string;
  name: string;
  iconBg?: string;
  className?: string;
  style?: React.CSSProperties;
  size?: number | string;
}

export const AppIcon: React.FC<AppIconProps> = ({
  icon,
  name,
  iconBg = 'linear-gradient(135deg, #0284c7, #0369a1)',
  className = '',
  style = {},
  size,
}) => {
  const [retryWithProxy, setRetryWithProxy] = useState(false);
  const [hasError, setHasError] = useState(false);

  // 判断是否为图片 URL 或资源路径
  const isUrl = Boolean(
    icon &&
      (icon.startsWith('http://') ||
        icon.startsWith('https://') ||
        icon.startsWith('/') ||
        icon.startsWith('data:image/') ||
        icon.includes('.png') ||
        icon.includes('.svg') ||
        icon.includes('.jpg') ||
        icon.includes('.webp') ||
        icon.includes('.ico'))
  );

  // 尝试的图片地址（若直连失败，自动尝试加速镜像重试）
  let currentSrc = icon;
  if (retryWithProxy && isUrl) {
    if (!currentSrc.startsWith('https://gh-proxy.com/')) {
      currentSrc = `https://gh-proxy.com/${icon}`;
    }
  }

  const handleError = () => {
    // 第一次失败尝试镜像代理
    if (!retryWithProxy && (icon.includes('github.com') || icon.includes('githubusercontent.com'))) {
      setRetryWithProxy(true);
    } else {
      // 镜像也失败，平滑降级为首字母徽章
      setHasError(true);
    }
  };

  // 生成首字母缩写徽章（如 RustDesk -> RD，LocalSend -> LS）
  const getInitials = (str: string) => {
    const clean = str.replace(/[^\w\s\u4e00-\u9fa5]/g, '').trim();
    if (!clean) return '📦';
    const words = clean.split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    // 驼峰拆分（如 RustDesk -> R D）
    const camelParts = clean.match(/[A-Z][a-z0-9]*/g);
    if (camelParts && camelParts.length >= 2) {
      return (camelParts[0][0] + camelParts[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
  };

  const isImageActive = isUrl && !hasError;

  const containerStyle: React.CSSProperties = {
    // 当为真实图片图标时，移除 PRD 占位渐变背景 (iconBg)，防止其在底层泄漏重叠；仅在 Emoji/首字母降级时启用 iconBg
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
          key={currentSrc}
          src={currentSrc}
          alt={name}
          className="app-icon-image"
          onError={handleError}
          loading="lazy"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: 'inherit',
            display: 'block',
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
