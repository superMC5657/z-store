import React from 'react';

interface BrandLogoProps {
  theme?: 'light' | 'dark';
  size?: number;
  className?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  theme = 'light',
  size = 22,
  className = '',
}) => {
  const isDark = theme === 'dark';

  return (
    <div
      className={`brand-logo-wrapper ${className}`}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
      title={`Z-Store (${isDark ? '暗夜模式' : '明亮模式'})`}
    >
      {isDark ? (
        // D-轻4: 晶透亚克力 (Dark Mode: Frosted Acrylic Translucent)
        <svg
          viewBox="0 0 512 512"
          width="100%"
          height="100%"
          xmlns="http://www.w3.org/2000/svg"
          style={{ transition: 'all 0.3s ease' }}
        >
          <defs>
            <linearGradient id="bl_dark_r1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#5865f2" />
              <stop offset="50%" stopColor="#4752c4" />
              <stop offset="100%" stopColor="#3c45a5" />
            </linearGradient>
            <linearGradient id="bl_dark_r2" x1="100%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#7983f5" />
              <stop offset="50%" stopColor="#5865f2" />
              <stop offset="100%" stopColor="#4752c4" />
            </linearGradient>
            <linearGradient id="bl_dark_rim" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
              <stop offset="50%" stopColor="rgba(88,101,242,0.3)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.08)" />
            </linearGradient>
            <filter id="bl_dark_glow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="6" stdDeviation="12" floodColor="#5865f2" floodOpacity="0.45" />
            </filter>
          </defs>
          <rect x="36" y="36" width="440" height="440" rx="105" ry="105" fill="rgba(255,255,255,0.08)" />
          <rect x="36" y="36" width="440" height="440" rx="105" ry="105" fill="none" stroke="url(#bl_dark_rim)" strokeWidth="3" />
          <g filter="url(#bl_dark_glow)">
            <path
              d="M 152 168 C 152 116 220 116 264 116 L 316 116 C 368 116 368 176 320 226 L 196 348 C 148 396 200 396 248 396 L 360 396"
              fill="none"
              stroke="url(#bl_dark_r1)"
              strokeWidth="44"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M 330 156 L 224 278 C 182 326 228 376 266 376 L 358 376"
              fill="none"
              stroke="url(#bl_dark_r2)"
              strokeWidth="36"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.92"
            />
            <circle cx="344" cy="116" r="16" fill="#5865f2" />
            <circle cx="344" cy="116" r="8" fill="#ffffff" />
          </g>
        </svg>
      ) : (
        // D-轻1: 冰川浅蓝 (Light Mode: Glacier Light Azure)
        <svg
          viewBox="0 0 512 512"
          width="100%"
          height="100%"
          xmlns="http://www.w3.org/2000/svg"
          style={{ transition: 'all 0.3s ease' }}
        >
          <defs>
            <linearGradient id="bl_light_bg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="50%" stopColor="#f8fafc" />
              <stop offset="100%" stopColor="#f0f9ff" />
            </linearGradient>
            <linearGradient id="bl_light_r1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38bdf8" />
              <stop offset="60%" stopColor="#0284c7" />
              <stop offset="100%" stopColor="#2563eb" />
            </linearGradient>
            <linearGradient id="bl_light_r2" x1="100%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#60a5fa" />
              <stop offset="50%" stopColor="#38bdf8" />
              <stop offset="100%" stopColor="#0284c7" />
            </linearGradient>
            <filter id="bl_light_shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="8" stdDeviation="12" floodColor="#0284c7" floodOpacity="0.2" />
            </filter>
            <filter id="bl_light_glow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="5" stdDeviation="10" floodColor="#0284c7" floodOpacity="0.22" />
            </filter>
          </defs>
          <rect x="36" y="36" width="440" height="440" rx="105" ry="105" fill="url(#bl_light_bg)" filter="url(#bl_light_shadow)" />
          <rect x="36" y="36" width="440" height="440" rx="105" ry="105" fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth="3" />
          <rect x="38" y="38" width="436" height="436" rx="103" ry="103" fill="none" stroke="rgba(2,132,199,0.16)" strokeWidth="1.5" />
          <g filter="url(#bl_light_glow)">
            <path
              d="M 152 168 C 152 116 220 116 264 116 L 316 116 C 368 116 368 176 320 226 L 196 348 C 148 396 200 396 248 396 L 360 396"
              fill="none"
              stroke="url(#bl_light_r1)"
              strokeWidth="44"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M 330 156 L 224 278 C 182 326 228 376 266 376 L 358 376"
              fill="none"
              stroke="url(#bl_light_r2)"
              strokeWidth="36"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.92"
            />
            <circle cx="344" cy="116" r="16" fill="#38bdf8" />
            <circle cx="344" cy="116" r="8" fill="#ffffff" />
          </g>
        </svg>
      )}
    </div>
  );
};
