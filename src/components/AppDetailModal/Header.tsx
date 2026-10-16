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
import { tauriApi, type AppIconCycleResult } from '../../services/api';
import { AppIcon } from '../AppIcon';
import { admitIconHit } from '../../services/iconStore';
import { notifyToast } from '../../utils/notify';
import { VerifiedBadge } from '../VerifiedBadge';
import { formatBytes } from '../../utils/appHelper';
import { PlatformIcon, ForgeIcon } from '../icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../../lib/platformFilter';
import { useDetailStarVerify } from './useDetailStarVerify';
import { IconLevelBadge, ICON_LEVEL_NAMES } from './IconLevelBadge';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface HeaderProps {
  app: AppDetailViewModel;
  displayName: string;
  displayDesc: string;
  displayCategory: string;
  primaryAsset?: ReleaseAsset;
  platformLoading: boolean;
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
  platformLoading,
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
  // 轮换口径就绪：首轮 restoreOrFetchIconCycle 落定前按钮不渲染（防 loading 期闪出）；
  // 成功/失败均置 true，失败回退 category 兜底口径（按钮按 category 显隐）。
  const [isIconCycleReady, setIsIconCycleReady] = useState(false);
  // 初次展示同步去重：同一 id+url 只 dispatch 一次，避免重复事件刷榜
  const iconSyncDispatchedRef = useRef<Set<string>>(new Set());

  // 图标写透 patch（与 useDetailCacheSync:266 iconPatch 同效）：
  // Header 不直持四列表 setters，显式 patch 声明与 App 侧 `subscribeIconWrites` 扇出幂等，
  // 实际四列表落定经扇出完成；此处传 patch 保证 `admitIconHit→patch→扇出` 同 tick 可观测（L2/L3/L4/L5 即默认）。
  const iconPatch = (_tid: string, _icon: string): void => {
    // 无直写：四列表经 App 扇出 `patchAppIconList` 落定（与 266 同体同效，幂等）。
  };

  useEffect(() => {
    let isMounted = true;
    setIconCycle(null);
    setIsIconCycleReady(false);
    if (!isTauri || !app.id) return;

    tauriApi
      .restoreOrFetchIconCycle(app.id)
      .then((data) => {
        if (!isMounted) return;
        if (data) {
          setIconCycle(data);
          // 初次展示跟随+双落盘：iconCycle.url 是 data: 即时展示（IPC临时），
          // 落盘一律用 remote_url（后端 snake_case 规范字段）；
          // data: 永不进盘，内存态短暂用 data: 由 AppIcon iconOverride 直显，榜单跟随用 persistUrl。
          // isCataloged 不阻止；L5/fallback 空（persistUrl ''）不 dispatch，避免把实图标清掉。
          const remote = typeof data.remote_url === 'string' ? data.remote_url.trim() : '';
          const fallbackUrl = typeof data.url === 'string' ? data.url.trim() : '';
          const persistUrl =
            remote !== '' ? remote : (!fallbackUrl.startsWith('data:') ? fallbackUrl : '');
          const curIcon = typeof app.icon === 'string' ? app.icon.trim() : '';
          if(persistUrl!==''&&persistUrl!==curIcon) {
            const dedupKey = `${String(app.id).trim().toLowerCase()}::${persistUrl}`;
            if (!iconSyncDispatchedRef.current.has(dedupKey)) {
              iconSyncDispatchedRef.current.add(dedupKey);
              // 初次展示跟随经店内唯一写口（M1 缓冲 + 文件预热；列表写透由详情同步侧持有 setters 完成，
              // 此处只做缓冲预热，不自发 IPC 预热、不走窗口总线）。
              // data: 永不直送（persistUrl 已剥 data:，空即 L5/空不发）；patch 与 266 同体（经扇出落定）。
              admitIconHit({
                id: app.id,
                icon: persistUrl,
                level: typeof data.level === 'number' ? data.level : undefined,
                patch: iconPatch,
              });
            }
          }
        }
        setIsIconCycleReady(true);
      })
      .catch(() => {
        // 降级不崩；口径仍置就绪，失败时按钮按 category 兜底显隐
        if (isMounted) setIsIconCycleReady(true);
      });

    return () => {
      isMounted = false;
    };
  }, [app.id]);

  const isCataloged = Boolean(
    iconCycle?.is_cataloged ??
    (app.category && app.category !== 'external')
  );

  const totalLevels = iconCycle?.total_levels ?? 5;
  const currentLevel = iconCycle?.level ?? 1;
  const nextLevel = currentLevel >= totalLevels ? 1 : currentLevel + 1;
  const nextLevelName = ICON_LEVEL_NAMES[nextLevel] || `L${nextLevel}`;
  const nextLevelTitle = `下一档：L${nextLevel}${nextLevelName} (${nextLevel}/${totalLevels})`;

  const effectiveIconOverride = useMemo(() => {
    if (!iconCycle) return undefined;
    if (iconCycle.level === 5 || iconCycle.is_fallback) {
      return iconCycle.url || '';
    }
    // 收录首开冷返回 {url:"", remote_url:L1实图, level:1}：空 url override 会压住
    // AppIcon 的 app.icon/buffered 真图导致首帧 MU 徽章。取 persistUrl 口径
    //（remote_url 优先、非 data: url 兜底）：空即 undefined 不覆盖，仅 L5 显式 ""。
    const rawUrl = typeof iconCycle.url === 'string' ? iconCycle.url.trim() : '';
    if (rawUrl !== '') return iconCycle.url;
    const remoteRaw =
      typeof iconCycle.remote_url === 'string'
        ? String(iconCycle.remote_url).trim()
        : '';
    const persistUrl =
      remoteRaw !== '' ? remoteRaw : (!rawUrl.startsWith('data:') ? rawUrl : '');
    // url=="" 且 persistUrl 有实图时返回 undefined，让 AppIcon 回落 app.icon 直显 http；
    // persistUrl 为空同样不覆盖（回落缓冲/父 prop）。
    if (persistUrl !== '') return undefined;
    return undefined;
  }, [iconCycle]);

  const handleCycleIcon = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 收录恒 L1 禁切：收录应用不给切（与 L1 官方锁定同语义）。
    if (isCyclingIcon || !isTauri || !app.id || isCataloged) return;
    setIsCyclingIcon(true);
    try {
      const res = await tauriApi.cycleAppIcon(app.id);
      if (res) {
        // 未收录手动定 Logo：选中即默认——setIconCycle+admitIconHit+patch 同 tick 即时响应；
        // L2/L3/L4 实图转正 http 才写透，L5 空（url ''）走显式徽章写，data: 仅经 iconOverride 即时看。
        setIconCycle(res);
        // 轮转跟随经店内写口：L5 空（url ''）走显式徽章写（清记忆 + 列表/镜像扇出）；
        // 实图经唯一写口缓冲预热；即时换图由 iconOverride 本地态直显，不走窗口总线。
        // data: 永不直送 admitIconHit，只做 iconOverride（persistUrl 为空即不发）。
        const rawCycledUrl = typeof res.url === 'string' ? res.url.trim() : '';
        const remoteRaw =
          typeof res.remote_url === 'string'
            ? String(res.remote_url).trim()
            : '';
        const persistUrl =
          remoteRaw !== ''
            ? remoteRaw
            : !rawCycledUrl.startsWith('data:') && rawCycledUrl !== ''
              ? rawCycledUrl
              : '';
        if (rawCycledUrl === '') {
          admitIconHit({ id: app.id, icon: '', level: 5, patch: iconPatch });
        } else if (persistUrl !== '') {
          admitIconHit({
            id: app.id,
            icon: persistUrl,
            level: typeof res.level === 'number' ? res.level : undefined,
            patch: iconPatch,
          });
        } else {
          // data: 仅即时看：已 setIconCycle（iconOverride 直显），此处不调 admitIconHit、不进盘。
        }
        const total = res.total_levels ?? 5;
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
      `## 环境\n- ZStore 客户端版本：桌面端\n- 应用版本：${app.latest_version}\n- 系统：${navigator.platform}\n\n## 问题描述\n\n## 复现步骤\n1. \n2. \n`
    );
    tauriApi.openUrl(`https://${host}/${app.owner}/${app.repo}/issues/new?title=${title}&body=${body}`);
  };

  const handleOpenExternal = (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    e.stopPropagation();
    tauriApi.openUrl(url);
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
          aria-label={isStarred ? '取消 GitHub 标星' : 'GitHub 标星 (Star)'}
          style={{
            color: isStarred ? '#eab308' : 'var(--text-secondary)',
            opacity: 1,
          }}
          title={
            isStarred
              ? '已在 GitHub 标星并存入 user_stars（点击取消 GitHub 标星）'
              : oauthUser
              ? oauthUser.has_list_scope
                ? 'GitHub 标星：在 GitHub 标星该仓库并存入 user_stars'
                : 'GitHub 标星：在 GitHub 标星（当前令牌缺少 user 权限，建议在设置中重新授权以同步至清单）'
              : 'GitHub 标星：在 GitHub 标星该仓库并存入 user_stars（需在设置中登录或配置令牌）'
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
            isCycleReady={isIconCycleReady}
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
            // loading-empty 骨架占位，已确认-empty 才 Other。
            const isModalLoading = Boolean(platformLoading);
            const showModalLoadingPlaceholder = !hasModalPlatforms && isModalLoading;
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
            if (showModalLoadingPlaceholder) {
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
