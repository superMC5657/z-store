import React from 'react';
import { ReleaseAsset } from '../../types';
import { formatBytes } from '../../utils/appHelper';

export interface AssetListProps {
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
  if (!showAllAssets) return null;

  return (
    <div className="settings-group" style={{ marginBottom: 0 }}>
      <div className="settings-group-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>GitHub Release 原生构建设施产物</span>
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 'normal', color: 'var(--text-tertiary)' }}>
          宿主环境匹配: {currentOs} ({currentArch})
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
                      当前目标
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
                  目标平台: {asset.os} ({asset.arch}) · 类型: {asset.kind} · 体积: {formatBytes(asset.size_bytes)}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {asset.sha256 && (
                  <span
                    className="trust-hash text-mono"
                    title={`官方校验值: ${asset.sha256}`}
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
                  title={isSelected ? '当前正在使用该版本安装' : '将此包选为当前安装目标'}
                >
                  {isSelected ? '✓ 已选用' : '选用此包'}
                </button>
                <a
                  href={asset.download_url}
                  onClick={(e) => onOpenExternal(e, asset.download_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-fluent btn-secondary detail-asset-btn"
                  title="在浏览器中直接下载"
                >
                  直链
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
