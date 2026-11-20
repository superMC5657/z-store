import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BookmarkPlus, Download, PackageCheck, X } from 'lucide-react';
import '../i18n';
import type { BatchInstallOutcome } from '../app/hooks/useInstallState';
import type { AppSummary, CollectionModalData, ShowToast } from '../types';
import { tauriApi } from '../services/api';
import { queueAssembledRowIcons } from '../services/iconStore';
import { normalizeId, normalizeIdLowerSet } from '../services/normalizeId';
import { detectHostOs, getAppDescription } from '../utils/appHelper';
import { AppIconFrame } from './AppIconFrame';
import { CountBadge } from './CountBadge';
import { EmptyState } from './EmptyState';
import { PlatformIcon } from './icons/PlatformIcons';
import { ModalShell } from './ModalShell';

export interface CollectionPreviewModalProps {
  collection: CollectionModalData;
  installedIds: ReadonlySet<string>;
  favoriteIds: ReadonlySet<string>;
  onClose: () => void;
  onOpenDetail?: (id: string) => void;
  onLoadUncatalogedDetail?: (id: string) => Promise<void> | void;
  onInstallApp: (id: string) => Promise<BatchInstallOutcome | void>;
  onToggleFavorite: (id: string) => Promise<boolean | void> | boolean | void;
  showToast?: ShowToast;
}

interface BatchProgress {
  current: number;
  total: number;
  name: string;
}

export const CollectionPreviewModal: React.FC<CollectionPreviewModalProps> = ({
  collection,
  installedIds,
  favoriteIds,
  onClose,
  onOpenDetail,
  onLoadUncatalogedDetail,
  onInstallApp,
  onToggleFavorite,
  showToast,
}) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [items, setItems] = useState<AppSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isBatchInstalling, setIsBatchInstalling] = useState(false);
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<BatchProgress | null>(null);
  const [isFavoritingAll, setIsFavoritingAll] = useState(false);
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(() => new Set());
  const [loadedDetailIds, setLoadedDetailIds] = useState<Set<string>>(() => new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const installedSetLower = useMemo(() => normalizeIdLowerSet(installedIds), [installedIds]);
  const favoriteSetLower = useMemo(() => normalizeIdLowerSet(favoriteIds), [favoriteIds]);
  const installedRef = useRef(installedSetLower);
  installedRef.current = installedSetLower;
  const rawInstalledRef = useRef(installedIds);
  rawInstalledRef.current = installedIds;

  const isAppInstalled = useCallback(
    (id: string) => installedSetLower.has(normalizeId(id)) || installedIds.has(id),
    [installedSetLower, installedIds],
  );

  const isAppFavorite = useCallback(
    (id: string) => favoriteSetLower.has(normalizeId(id)) || favoriteIds.has(id),
    [favoriteSetLower, favoriteIds],
  );

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError(null);
    setLoadedDetailIds(new Set());

    tauriApi
      .resolveCollectionApps(collection.app_ids)
      .then((resolved) => {
        if (!active) return;
        const list = Array.isArray(resolved) ? resolved : [];
        setItems(list);
        if (list.length > 0) {
          queueAssembledRowIcons(list);
        }
        const hostOs = detectHostOs();
        const initialSelected = new Set<string>();
        for (const app of list) {
          const norm = normalizeId(app.id);
          if (installedRef.current.has(norm) || rawInstalledRef.current.has(app.id)) continue;
          const matchesHost =
            app.platforms.length === 0 ||
            app.platforms.some((p) => p.toLowerCase() === hostOs);
          if (matchesHost) {
            initialSelected.add(norm);
          }
        }
        setSelectedIds(initialSelected);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [collection]);

  const uninstalledItems = useMemo(
    () => items.filter((app) => !isAppInstalled(app.id)),
    [items, isAppInstalled],
  );

  const selectedInstallItems = useMemo(
    () => uninstalledItems.filter((app) => selectedIds.has(normalizeId(app.id))),
    [uninstalledItems, selectedIds],
  );

  const allUninstalledSelected =
    uninstalledItems.length > 0 &&
    uninstalledItems.every((app) => selectedIds.has(normalizeId(app.id)));

  const unFavoritedItems = useMemo(
    () => items.filter((app) => !isAppFavorite(app.id)),
    [items, isAppFavorite],
  );

  const handleToggleRow = (app: AppSummary) => {
    if (isBatchInstalling || isAppInstalled(app.id)) return;
    const key = normalizeId(app.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleToggleSelectAll = () => {
    if (isBatchInstalling || uninstalledItems.length === 0) return;
    if (allUninstalledSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(uninstalledItems.map((app) => normalizeId(app.id))));
    }
  };

  const handleFavoriteAll = async () => {
    if (isFavoritingAll || isBatchInstalling) return;
    if (unFavoritedItems.length === 0) {
      showToast?.(t('collection.preview.favorite_all_noop'), 'info');
      return;
    }
    setIsFavoritingAll(true);
    let added = 0;
    let failed = 0;
    try {
      for (const app of unFavoritedItems) {
        try {
          const ok = await onToggleFavorite(app.id);
          if (ok === false) {
            failed += 1;
          } else {
            added += 1;
          }
        } catch {
          failed += 1;
        }
      }
      if (!mountedRef.current) return;
      if (added > 0 && failed === 0) {
        showToast?.(t('collection.preview.favorite_all_done', { count: added }), 'success');
      } else if (added > 0 && failed > 0) {
        showToast?.(t('collection.preview.favorite_all_partial', { added, failed }), 'warning');
      } else if (failed > 0) {
        showToast?.(t('collection.preview.favorite_all_failed', { failed }), 'error');
      }
    } finally {
      if (mountedRef.current) setIsFavoritingAll(false);
    }
  };

  const handleBatchInstall = async () => {
    if (isBatchInstalling || selectedInstallItems.length === 0) return;
    const targets = [...selectedInstallItems];
    setIsBatchInstalling(true);
    let success = 0;
    let failed = 0;

    try {
      for (let i = 0; i < targets.length; i += 1) {
        const app = targets[i];
        if (!mountedRef.current) break;
        setInstallingAppId(app.id);
        setInstallProgress({ current: i + 1, total: targets.length, name: app.name });
        try {
          const outcome = await onInstallApp(app.id);
          if (outcome === 'cancelled' || outcome === 'skipped') {
            failed += 1;
          } else {
            success += 1;
          }
        } catch {
          failed += 1;
        }
      }
    } finally {
      if (mountedRef.current) {
        setIsBatchInstalling(false);
        setInstallingAppId(null);
        setInstallProgress(null);
      }
    }

    if (!mountedRef.current || (success === 0 && failed === 0)) return;
    if (failed === 0) {
      showToast?.(t('collection.preview.batch_install_done', { success }), 'success');
    } else {
      showToast?.(
        t('collection.preview.batch_install_partial', { success, failed }),
        'warning',
      );
    }
  };

  const handleLoadRowDetail = async (id: string) => {
    if (!onLoadUncatalogedDetail) return;
    const norm = normalizeId(id);
    setLoadingDetailIds((prev) => new Set(prev).add(norm));
    try {
      await onLoadUncatalogedDetail(id);
      const refreshed = await tauriApi.resolveCollectionApps(collection.app_ids);
      if (mountedRef.current && Array.isArray(refreshed) && refreshed.length > 0) {
        setItems(refreshed);
        queueAssembledRowIcons(refreshed);
        setLoadedDetailIds((prev) => new Set(prev).add(norm));
        const loadedRow = refreshed.find((item) => normalizeId(item.id) === norm);
        if (loadedRow && loadedRow.platforms.length > 0) {
          const currentHost = detectHostOs();
          const compatible = loadedRow.platforms.some((p) => p.toLowerCase() === currentHost);
          if (!compatible) {
            setSelectedIds((prev) => {
              if (!prev.has(norm)) return prev;
              const next = new Set(prev);
              next.delete(norm);
              return next;
            });
          }
        }
      }
    } catch {
      // 忽略行内按需加载错误，用户可点进详情页重试
    } finally {
      if (mountedRef.current) {
        setLoadingDetailIds((prev) => {
          const next = new Set(prev);
          next.delete(norm);
          return next;
        });
      }
    }
  };

  const displayTitle = collection.title.trim() || t('collection.preview.default_title');
  const displayNote = collection.note?.trim() || '';
  const hostOs = detectHostOs();

  return (
    <ModalShell
      layer="base"
      onClose={onClose}
      closeOnBackdrop={!isBatchInstalling}
      onEscape={isBatchInstalling ? () => {} : onClose}
      panelClassName="collection-modal"
      ariaLabelledBy={titleId}
    >
      <div className="collection-modal-header">
        <div className="collection-modal-heading">
          <h3 id={titleId} className="collection-modal-title-row">
            <span>{displayTitle}</span>
            {!isLoading && !loadError && <CountBadge value={items.length} />}
          </h3>
          <p className="collection-modal-subtitle">{t('collection.preview.subtitle')}</p>
          {displayNote && <p className="collection-modal-note">{displayNote}</p>}
        </div>
        <button
          type="button"
          className="modal-header-btn"
          onClick={onClose}
          disabled={isBatchInstalling}
          aria-label={t('collection.preview.close')}
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <div className="modal-body collection-modal-body">
        {isLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 16px', gap: '10px', color: 'var(--text-secondary)' }}>
            <span className="spinner-icon" style={{ width: '16px', height: '16px', borderWidth: '2px' }} />
            <span>{t('collection.preview.loading')}</span>
          </div>
        ) : loadError ? (
          <div className="collection-length-warning is-exceeded">
            <AlertTriangle size={15} strokeWidth={1.5} aria-hidden="true" />
            <span>{t('collection.preview.load_failed', { error: loadError })}</span>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<PackageCheck size={36} strokeWidth={1.5} />}
            title={t('collection.preview.empty')}
            description=""
          />
        ) : (
          <div className="collection-list">
            {items.map((app) => {
              const installed = isAppInstalled(app.id);
              const norm = normalizeId(app.id);
              const isSelected = !installed && selectedIds.has(norm);
              const isInstallingRow = installingAppId === app.id;
              const desc = getAppDescription(app, i18n.language);
              const needsDetailLoad =
                onLoadUncatalogedDetail !== undefined &&
                app.is_cataloged === false &&
                app.platforms.length === 0 &&
                !loadedDetailIds.has(norm);
              const supportsHost =
                app.platforms.length === 0 ||
                app.platforms.some((p) => p.toLowerCase() === hostOs);

              return (
                <div
                  key={app.id}
                  className={`collection-row ${isSelected ? 'is-selected' : ''} ${installed ? 'is-disabled' : ''}`.trim()}
                >
                  <input
                    type="checkbox"
                    className="collection-checkbox"
                    checked={isSelected}
                    disabled={installed || isBatchInstalling}
                    onChange={() => handleToggleRow(app)}
                    aria-label={app.name}
                  />
                  <AppIconFrame
                    size="sm"
                    icon={app.icon}
                    name={app.name}
                    appId={app.id}
                    iconBg={app.icon_bg}
                    onClick={onOpenDetail ? () => onOpenDetail(app.id) : undefined}
                    title={onOpenDetail ? t('app.view_details') : undefined}
                  />
                  <div className="collection-row-main">
                    <div className="collection-row-top">
                      {onOpenDetail ? (
                        <button
                          type="button"
                          className="collection-row-name-btn"
                          onClick={() => onOpenDetail(app.id)}
                        >
                          {app.name}
                        </button>
                      ) : (
                        <span className="collection-row-name-btn">{app.name}</span>
                      )}
                      <span className="collection-row-repo">
                        {app.owner}/{app.repo}
                      </span>
                      {app.license && <span className="status-tag">{app.license}</span>}
                      {app.platforms.length > 0 && (
                        <span className="collection-row-platforms">
                          {app.platforms.map((platform) => (
                            <PlatformIcon key={platform} platform={platform} size={12} />
                          ))}
                        </span>
                      )}
                      {!supportsHost && !installed && (
                        <span className="status-tag">{t('collection.preview.incompatible_hint')}</span>
                      )}
                    </div>
                    {desc && <p className="collection-row-desc">{desc}</p>}
                  </div>
                  <div className="collection-row-right">
                    {isInstallingRow ? (
                      <span className="status-tag">
                        <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px', marginRight: '4px' }} />
                        {t('collection.preview.installing_tag')}
                      </span>
                    ) : installed ? (
                      <span className="status-tag">{t('collection.preview.installed_tag')}</span>
                    ) : needsDetailLoad ? (
                      <button
                        type="button"
                        className="btn-fluent btn-secondary btn-sm"
                        disabled={loadingDetailIds.has(norm) || isBatchInstalling}
                        onClick={() => void handleLoadRowDetail(app.id)}
                      >
                        {t('collection.preview.load_detail')}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="modal-footer collection-footer">
        <div className="collection-footer-left">
          <button
            type="button"
            className="btn-fluent btn-secondary btn-compact"
            disabled={isLoading || uninstalledItems.length === 0 || isBatchInstalling}
            onClick={handleToggleSelectAll}
          >
            {allUninstalledSelected
              ? t('collection.preview.deselect_all')
              : t('collection.preview.select_all_uninstalled')}
          </button>
          {installProgress ? (
            <span className="collection-progress-text" role="status">
              {t('collection.preview.installing_progress', {
                current: installProgress.current,
                total: installProgress.total,
                name: installProgress.name,
              })}
            </span>
          ) : (
            !isLoading &&
            uninstalledItems.length > 0 && (
              <span className="collection-progress-text">
                {t('collection.preview.selected_summary', { count: selectedInstallItems.length })}
              </span>
            )
          )}
        </div>

        <div className="collection-footer-right">
          <button
            type="button"
            className="btn-fluent btn-secondary btn-compact"
            disabled={isLoading || items.length === 0 || isFavoritingAll || isBatchInstalling}
            onClick={() => void handleFavoriteAll()}
          >
            <BookmarkPlus size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{t('collection.preview.favorite_all')}</span>
          </button>
          <button
            type="button"
            className="btn-fluent btn-primary btn-compact"
            disabled={isLoading || selectedInstallItems.length === 0 || isBatchInstalling}
            onClick={() => void handleBatchInstall()}
          >
            <Download size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{t('collection.preview.install_selected')}</span>
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
