import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  User,
  Bug,
  Monitor,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppDetailViewModel, OAuthUser, ReleaseAsset } from '../../types';
import { api, normalizeIconCycle, type AppIconCycleResult } from '../../services/api';
import { AppIcon, invalidateIconCache, isAvatarUrl } from '../AppIcon';
import { notifyToast } from '../../utils/notify';
import { VerifiedBadge } from '../VerifiedBadge';
import { formatBytes } from '../../utils/appHelper';
import { PlatformIcon, ForgeIcon } from '../icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../../lib/platformFilter';
import { useDetailStarVerify } from '../useDetailStarVerify';
import { IconLevelBadge, ICON_LEVEL_NAMES } from './IconLevelBadge';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface HeaderProps {
  app: AppDetailViewModel;
  displayName: string;
  displayDesc: string;
  displayCategory: string;
  primaryAsset?: ReleaseAsset;
  platformPending?: boolean;
  oauthUser?: OAuthUser | null;
  isFavorite?: boolean;
  isWatched?: boolean;
  onClose: () => void;
  onRefresh?: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  onToggleWatch?: (id: string) => void;
  onOpenDeveloperProfile?: (developer: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  app,
  displayName,
  displayDesc,
  displayCategory,
  primaryAsset,
  platformPending,
  oauthUser = null,
  isFavorite = false,
  isWatched = false,
  onClose,
  onRefresh,
  onToggleFavorite,
  onToggleWatch,
  onOpenDeveloperProfile,
}) => {
  const { t } = useTranslation();

  // 图标轮换态（T3 刷新图标）
  const [iconCycle, setIconCycle] = useState<AppIconCycleResult | null>(null);
  const [isCyclingIcon, setIsCyclingIcon] = useState(false);
  // 初次展示同步去重：同一 id+url 只 dispatch 一次，避免重复事件刷榜
  const iconSyncDispatchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let isMounted = true;
    setIconCycle(null);
    if (!isTauri || !app.id) return;

    api
      .getAppIconCycle(app.id)
      .then((data) => {
        if (isMounted && data) {
          setIconCycle(data);
          // 初次展示跟随+双落盘：iconCycle.url 是 data: 即时展示（IPC临时），
          // 落盘一律用 remote_url（normalizeIconCycle 收敛，remote_url优先、camel兜底）；
          // data: 永不进盘，内存态短暂用 data: 由 AppIcon iconOverride 直显，榜单跟随用 persistUrl。
          // isCataloged 不阻止；L5/fallback 空（persistUrl ''）不 dispatch，避免把实图标清掉。
          const normalized = normalizeIconCycle(data);
          const remote = typeof normalized?.remoteUrl === 'string' ? normalized.remoteUrl.trim() : '';
          const fallbackUrl = typeof data.url === 'string' ? data.url.trim() : '';
          const persistUrl =
            remote !== '' ? remote : (!fallbackUrl.startsWith('data:') ? fallbackUrl : '');
          const curIcon = typeof app.icon === 'string' ? app.icon.trim() : '';
          if (persistUrl !== '' && !isAvatarUrl(persistUrl) && persistUrl !== curIcon) {
            const dedupKey = `${String(app.id).trim().toLowerCase()}::${persistUrl}`;
            if (!iconSyncDispatchedRef.current.has(dedupKey)) {
              iconSyncDispatchedRef.current.add(dedupKey);
              // 预热文件：触发 Rust getOrFetchIcon 落盘副作用（icons/* 二进制 + catalog/cycle 行），失败不阻塞
              void api.getOrFetchIcon(app.id, persistUrl).catch(() => {});
              invalidateIconCache(app.id);
              window.dispatchEvent(
                new CustomEvent('zstore:icon-changed', {
                  detail: { appId: app.id, icon: persistUrl },
                })
              );
            }
          }
        }
      })
      .catch(() => {
        // 降级不崩
      });

    return () => {
      isMounted = false;
    };
  }, [app.id]);

  const isCataloged = Boolean(
    iconCycle?.is_cataloged ??
    iconCycle?.isCataloged ??
    (app.category && app.category !== 'external')
  );

  const totalLevels = iconCycle?.total_levels ?? iconCycle?.totalLevels ?? 5;
  const currentLevel = iconCycle?.level ?? 1;
  const nextLevel = currentLevel >= totalLevels ? 1 : currentLevel + 1;
  const nextLevelName = ICON_LEVEL_NAMES[nextLevel] || `L${nextLevel}`;
  const nextLevelTitle = `下一档：L${nextLevel}${nextLevelName} (${nextLevel}/${totalLevels})`;

  const effectiveIconOverride = useMemo(() => {
    if (!iconCycle) return undefined;
    if (iconCycle.level === 5 || iconCycle.is_fallback || iconCycle.isFallback) {
      return iconCycle.url || '';
    }
    return iconCycle.url;
  }, [iconCycle]);

  const handleCycleIcon = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isCyclingIcon || !isTauri || !app.id || isCataloged) return;
    setIsCyclingIcon(true);
    try {
      const res = await api.cycleAppIcon(app.id);
      if (res) {
        setIconCycle(res);
        invalidateIconCache(app.id);
        window.dispatchEvent(
          new CustomEvent('zstore:icon-changed', {
            detail: { appId: app.id, icon: res.url },
          })
        );
        const total = res.total_levels ?? res.totalLevels ?? 5;
        const name = ICON_LEVEL_NAMES[res.level] || '';
        notifyToast(`图标已切换为 L${res.level}${name} (${res.level}/${total})`, 'success');
      }
    } catch (err) {
      notifyToast(`切换图标失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setIsCyclingIcon(false);
    }
  };

  // FR-7: GitHub 标星（见 useDetailStarVerify）；已认证蓝标由 catalog 驱动展示（is_verified + VerifiedBadge）
  const {
    isStarred,
    isStarring,
    handleToggleStar,
  } = useDetailStarVerify({
    appId: app.id,
    owner: app.owner,
    repo: app.repo,
    appName: app.name,
    oauthLogin: oauthUser?.login,
    onRefresh,
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshSuccessNotice, setRefreshSuccessNotice] = useState(false);
  const [refreshErrorNotice, setRefreshErrorNotice] = useState<string | null>(null);

  const effectiveRefreshing = Boolean(isRefreshing || app.isRefreshing);

  const handleTriggerRefresh = async () => {
    if (!onRefresh || effectiveRefreshing) return;
    setIsRefreshing(true);
    setRefreshSuccessNotice(false);
    setRefreshErrorNotice(null);

    try {
      await onRefresh(app.id);
      setRefreshSuccessNotice(true);
      setTimeout(() => {
        setRefreshSuccessNotice(false);
      }, 2800);
    } catch (err) {
      setRefreshErrorNotice(String(err));
      setTimeout(() => {
        setRefreshErrorNotice(null);
      }, 3500);
    } finally {
      setIsRefreshing(false);
    }
  };

  // FR-7.3: 问题反馈 → 预填标题与正文直达仓库 Issues 新建页（复用 openUrl 外链通道）
  const handleOpenIssueFeedback = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const host = app.forge_host || 'github.com';
    const title = encodeURIComponent(`【反馈】${displayName} ${app.latest_version}`);
    const body = encodeURIComponent(
      `## 环境\n- Z-Store 客户端版本：桌面端\n- 应用版本：${app.latest_version}\n- 系统：${navigator.platform}\n\n## 问题描述\n\n## 复现步骤\n1. \n2. \n`
    );
    api.openUrl(`https://${host}/${app.owner}/${app.repo}/issues/new?title=${title}&body=${body}`);
  };

  const handleOpenExternal = (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    e.stopPropagation();
    api.openUrl(url);
  };

  return (
    <div className="modal-header">
      <div className="modal-actions-header" style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 10 }}>
        {onRefresh && (
          <button
            className={`modal-header-btn ${effectiveRefreshing ? 'btn-refreshing' : ''}`}
            onClick={handleTriggerRefresh}
            disabled={effectiveRefreshing}
            aria-label="强制从远端刷新应用信息与最新发布"
            title={effectiveRefreshing ? '正在从远端重新同步数据...' : '强制从远端刷新 (穿透本地缓存)'}
            style={{ color: effectiveRefreshing ? 'var(--brand-primary)' : 'var(--text-secondary)' }}
          >
            <svg
              className={effectiveRefreshing ? 'icon-spin' : ''}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
        )}
        {onToggleFavorite && (
          <button
            className="modal-header-btn"
            onClick={() => onToggleFavorite(app.id)}
            aria-label={isFavorite ? '取消应用内收藏' : '加入应用内收藏'}
            style={{ color: isFavorite ? '#eab308' : 'var(--text-secondary)' }}
            title={isFavorite ? '已加入应用内收藏（存入本地数据库 · 点击取消）' : '应用内收藏：保存至本机数据库，离线随时可用'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isFavorite ? '#eab308' : 'none'} stroke={isFavorite ? '#eab308' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
        {onToggleWatch && (
          <button
            className="modal-header-btn"
            onClick={() => onToggleWatch(app.id)}
            aria-label={isWatched ? '取消关注 Release 更新' : '关注 Release 更新'}
            style={{ color: isWatched ? 'var(--brand-primary)' : 'var(--text-secondary)' }}
            title={isWatched ? '已关注该应用的新版本动态（新 Release 发布时在应用内提醒 · 点击取消）' : '关注 Release 更新：该应用发布新版本时在应用内提醒'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
        <button
          className="modal-header-btn"
          onClick={handleToggleStar}
          disabled={isStarring}
          aria-label={isStarred ? '取消 GitHub 收藏' : 'GitHub 收藏 (Star)'}
          style={{
            color: isStarred ? '#eab308' : 'var(--text-secondary)',
            opacity: 1,
          }}
          title={
            isStarred
              ? '已在 GitHub 标星并存入 z-store-list 列表（点击取消 GitHub 收藏）'
              : oauthUser
              ? oauthUser.has_list_scope
                ? 'GitHub 收藏：在 GitHub 标星该仓库并存入 z-store-list 列表'
                : 'GitHub 收藏：在 GitHub 标星（当前令牌缺少 user 权限，建议在设置中重新授权以同步至清单）'
              : 'GitHub 收藏：在 GitHub 标星该仓库并存入列表（需在设置中登录或配置令牌）'
          }
        >
          {isStarring ? (
            <svg className="icon-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isStarred ? '#eab308' : 'none'} stroke={isStarred ? '#eab308' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          )}
        </button>
        <button
          className="modal-close-btn"
          onClick={onClose}
          aria-label="关闭详情弹窗"
          style={{ position: 'relative', top: 'auto', right: 'auto' }}
        >
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>

      <AppIcon
        key={`${app.id}-${iconCycle?.level ?? 1}`}
        icon={app.icon}
        iconOverride={effectiveIconOverride}
        name={displayName}
        appId={app.id}
        iconBg={app.icon_bg}
        className="modal-app-icon"
      />

      <div className="modal-header-info">
        <div className="modal-app-title">
          <span>{displayName}</span>
          {app.is_verified && <VerifiedBadge size="md" />}
        </div>
        <div className="modal-app-repo" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {onOpenDeveloperProfile ? (
            <button
              type="button"
              onClick={() => onOpenDeveloperProfile(app.owner)}
              className="btn-fluent btn-secondary"
              style={{
                padding: '2px 8px',
                fontSize: 'var(--font-sm)',
                fontWeight: 510,
                borderRadius: 'var(--radius-xs)',
                color: 'var(--brand-primary)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                lineHeight: '1.4',
              }}
              title={`查看 ${app.owner} 开发者全景与开源项目`}
            >
              <User size={12} strokeWidth={1.5} />
              <span>{app.owner}</span>
            </button>
          ) : (
            <span>{app.owner}</span>
          )}
          <span>/</span>
          <a
            href={app.forge_host ? `https://${app.forge_host}/${app.owner}/${app.repo}` : `https://github.com/${app.owner}/${app.repo}`}
            onClick={(e) => handleOpenExternal(e, app.forge_host ? `https://${app.forge_host}/${app.owner}/${app.repo}` : `https://github.com/${app.owner}/${app.repo}`)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontWeight: 510, color: 'inherit', textDecoration: 'none' }}
            title="在浏览器中查看开源仓库"
          >
            {app.repo} ↗
          </a>
          <span>·</span>
          <span>最新发布 {app.latest_version}</span>
          <span>·</span>
          <a
            href={`https://${app.forge_host || 'github.com'}/${app.owner}/${app.repo}/issues/new`}
            onClick={handleOpenIssueFeedback}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontWeight: 510, color: 'var(--brand-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            title="前往开源仓库提交问题反馈（自动预填版本信息）"
          >
            <Bug size={12} strokeWidth={1.5} />
            <span>问题反馈</span>
          </a>
          <IconLevelBadge
            isCataloged={isCataloged}
            isCyclingIcon={isCyclingIcon}
            nextLevelTitle={nextLevelTitle}
            onCycleIcon={handleCycleIcon}
          />
        </div>
        {displayDesc && (
          <p
            className="modal-app-desc"
            style={{
              fontSize: 'var(--font-base)',
              color: 'var(--text-secondary)',
              margin: '4px 0 10px 0',
              lineHeight: '1.5',
            }}
          >
            {displayDesc}
          </p>
        )}
        <div className="modal-tags">
          <span className="modal-tag">★ {((app.stars || 0) / 1000).toFixed(1)}k</span>
          <span className="modal-tag">{app.license}</span>
          <span className="modal-tag">{displayCategory}</span>
          {(() => {
            const hasModalPlatforms = !!app.platforms && app.platforms.length > 0;
            // 传入 platformPending 即启用待确认语义：pending-empty 骨架占位，已确认-empty 才 Other；
            // 缺席时沿用旧语义（isLoading 即 pending），旧调用方零变化。
            const isModalPending = platformPending ?? Boolean(app.isLoading);
            const showModalPendingPlaceholder = !hasModalPlatforms && isModalPending;
            if (hasModalPlatforms) {
              return (
                <span
                  className="modal-tag"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  title={`支持设备: ${app.platforms!.map((p) => PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p).join(', ')}`}
                >
                  <Monitor size={12} />
                  <span>支持端:</span>
                  {app.platforms!.map((p) => (
                    <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                      <PlatformIcon platform={p} size={11} />
                      <span>{PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p}</span>
                    </span>
                  ))}
                </span>
              );
            }
            if (showModalPendingPlaceholder) {
              return (
                <span
                  className="modal-tag"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', opacity: 0.6 }}
                  title={t('app.supported_devices', { defaultValue: '支持设备' })}
                  aria-label={t('app.supported_devices', { defaultValue: '支持设备' })}
                >
                  <Monitor size={12} />
                  <span>支持端:</span>
                  <span
                    aria-hidden="true"
                    style={{ width: '34px', height: '10px', borderRadius: '3px', background: 'var(--border-subtle)', display: 'inline-block' }}
                  />
                </span>
              );
            }
            return (
              <span
                className="modal-tag"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                title={`${t('app.supported_devices', { defaultValue: '支持设备' })}: ${t('nav.platforms_other')}`}
              >
                <Monitor size={12} />
                <span>支持端:</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                  <PlatformIcon platform="other" size={11} />
                  <span>{t('nav.platforms_other')}</span>
                </span>
              </span>
            );
          })()}
          {app.forge && app.forge !== 'github' && (
            <span
              className="modal-tag"
              style={{
                background: 'var(--brand-subtle)',
                color: 'var(--brand-primary)',
                border: '1px solid var(--border-nav-active)',
                fontWeight: 510,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <ForgeIcon forge={app.forge} size={12} />
              <span>{app.forge === 'codeberg' ? 'Codeberg 源' : app.forge === 'gitea' ? 'Gitea 源' : `${app.forge_host || app.forge}`}</span>
            </span>
          )}
          {primaryAsset && (
            <span className="modal-tag">大小 {formatBytes(primaryAsset.size_bytes)}</span>
          )}
          {app.is_stale && (
            <span
              className="modal-tag"
              style={{
                background: 'rgba(245, 158, 11, 0.15)',
                color: '#f59e0b',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                fontWeight: 510,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
              title="网络不可用或请求受限，当前正在呈现本地历史数据"
            >
              <AlertTriangle size={11} strokeWidth={1.5} />
              <span>离线缓存</span>
            </span>
          )}

          {/* 刷新状态与微动效反馈 */}
          {refreshSuccessNotice ? (
            <span
              className="modal-tag modal-tag-success tag-spring-in"
              title="已成功同步最新版本与文档数据"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>已同步最新数据</span>
            </span>
          ) : refreshErrorNotice ? (
            <span
              className="modal-tag modal-tag-error tag-spring-in"
              title={`远端拉取失败: ${refreshErrorNotice}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <AlertTriangle size={11} />
              <span>同步异常，请重试</span>
            </span>
          ) : effectiveRefreshing ? (
            <span className="modal-tag modal-tag-refreshing tag-spring-in">
              <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px' }} />
              <span>正在同步最新数据...</span>
            </span>
          ) : (
            app.cached_at && !app.is_stale && (
              <span
                className="modal-tag"
                style={{ fontSize: 'var(--font-xs)', opacity: 0.8, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                title={`最后缓存时间：${new Date(app.cached_at * 1000).toLocaleString()}`}
              >
                <Clock size={11} />
                <span>{new Date(app.cached_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 缓存</span>
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
};
