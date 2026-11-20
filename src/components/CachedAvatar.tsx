import React, { useEffect, useState } from 'react';
import {
  getSyncCachedAssetUri,
  resolveCachedAssetUri,
} from '../services/assetCache';
import { isRealTauriRuntime } from '../services/tauriRuntime';

interface CachedAvatarProps {
  src?: string | null;
  login: string;
  size: number;
  style?: React.CSSProperties;
  className?: string;
  /** 凭证过期等弱化态：降低不透明度并半灰度。 */
  dimmed?: boolean;
  /** 弱化态不透明度（缺省 0.65）。 */
  dimmedOpacity?: number;
}

/** GitHub 头像组件：Tauri 下经本地缓存以 `data:` 渲染，失败或缺失时回退首字母圆形徽章。 */
export const CachedAvatar: React.FC<CachedAvatarProps> = ({
  src,
  login,
  size,
  style,
  className,
  dimmed = false,
  dimmedOpacity = 0.65,
}) => {
  const raw = (src ?? '').trim();
  const real = isRealTauriRuntime();
  const initial = !raw ? '' : real ? (getSyncCachedAssetUri(raw) ?? '') : raw;
  const [resolved, setResolved] = useState<{ key: string; uri: string }>({ key: raw, uri: initial });
  const [failedUri, setFailedUri] = useState('');

  useEffect(() => {
    if (!raw || !real) return;
    if (getSyncCachedAssetUri(raw)) return;
    let cancelled = false;
    void resolveCachedAssetUri(raw).then((uri) => {
      if (!cancelled) setResolved({ key: raw, uri });
    });
    return () => {
      cancelled = true;
    };
  }, [raw, real]);

  const uri = resolved.key === raw && resolved.uri ? resolved.uri : initial;
  const dimStyle: React.CSSProperties = dimmed
    ? { opacity: dimmedOpacity, filter: 'grayscale(50%)' }
    : {};
  const base: React.CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    flexShrink: 0,
    ...dimStyle,
    ...style,
  };

  if (uri && uri !== failedUri) {
    return (
      <img
        src={uri}
        alt={login}
        className={className}
        decoding="async"
        onError={() => setFailedUri(uri)}
        style={{ objectFit: 'cover', ...base }}
      />
    );
  }

  const letter = (login.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      role="img"
      aria-label={login}
      className={className ? `cached-avatar-fallback ${className}` : 'cached-avatar-fallback'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        background: 'var(--bg-card-hover)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-secondary)',
        fontSize: `${Math.max(9, Math.round(size * 0.46))}px`,
        fontWeight: 590,
        lineHeight: 1,
        userSelect: 'none',
        ...base,
      }}
    >
      {letter}
    </span>
  );
};
