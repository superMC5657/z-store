import React from 'react';
import { useTranslation } from 'react-i18next';
import { ReleaseAsset } from '../../types';
import { formatBytes } from '../../utils/appHelper';

interface AssetListProps {
  showAllAssets: boolean;
  releases: ReleaseAsset[];
  primaryAsset?: ReleaseAsset;
  currentOs: string;
  currentArch: string;
  effectiveIsBusy: boolean;
  onSelectAsset: (name: string) => void;
  onOpenExternal: (e: React.MouseEvent, url: string) => void;
}

export const AssetList: React.FC<AssetListProps> = ({
  showAllAssets,
  releases,
  primaryAsset,
  currentOs,
  currentArch,
  effectiveIsBusy,
  onSelectAsset,
  onOpenExternal,
}) => {
  const { t } = useTranslation();
  if (!showAllAssets) return null;

  return (
    <div className="settings-group" style={{ marginBottom: 0 }}>
      <div className="settings-group-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{t('detail.assets_title')}</span>
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 'normal', color: 'var(--text-tertiary)' }}>
          {t('detail.asset_host_match', { os: currentOs, arch: currentArch })}
        </span>
      </div>
      <div className="asset-list-scroll">
        {releases.map((asset) => {
          const isSelected = asset.name === primaryAsset?.name;
          return (
            <div key={asset.name} className="settings-row" style={{ padding: '12px 20px' }}>
              <div>
                <div style={{ fontWeight: 510, display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>{asset.name}</span>
                  {isSelected && (
                    <span
                      className="modal-tag modal-tag-success"
                      style={{ fontSize: 'calc(10px * var(--font-scale))', padding: '1px 6px' }}
                    >
                      {t('detail.asset_current')}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
                  {t('detail.asset_meta', { os: asset.os, arch: asset.arch, kind: asset.kind, size: formatBytes(asset.size_bytes) })}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {asset.sha256 && (
                  <span
                    className="trust-hash text-mono"
                    title={t('detail.asset_sha_title', { sha: asset.sha256 })}
                    style={{ maxWidth: '120px' }}
                  >
                    SHA-256: {asset.sha256.slice(0, 10)}...
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSelectAsset(asset.name)}
                  className={`btn-fluent ${isSelected ? 'btn-primary' : 'btn-secondary'} detail-asset-btn`}
                  disabled={effectiveIsBusy}
                  title={isSelected ? t('detail.asset_selected_title') : t('detail.asset_select_title')}
                >
                  {isSelected ? t('detail.asset_selected') : t('detail.asset_select')}
                </button>
                <a
                  href={asset.download_url}
                  onClick={(e) => onOpenExternal(e, asset.download_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-fluent btn-secondary detail-asset-btn"
                  title={t('detail.asset_download_title')}
                >
                  {t('detail.asset_direct_link')}
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
