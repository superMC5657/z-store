import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Globe,
  RotateCcw,
  Zap,
  Check,
  ChevronUp,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import { OAuthAccountCard } from '../../../components/OAuthAccountCard';

export interface NetworkDataSectionProps {
  proxyInput: string;
  setProxyInput: (val: string) => void;
  isTestingProxy: boolean;
  proxyTestResult: {
    success: boolean;
    latency_ms: number;
    text: string;
    badge: string;
  } | null;
  proxySavedFeedback: string | null;
  highlightRow: string | null;
  activeNotice: { key: string; text: string } | null;
  handleTestProxy: () => void;
  handleSaveProxy: () => void;
  catalogSourceUrl: string;
  setCatalogSourceUrl: (url: string) => void;
  setCatalogUrlSaved: (saved: boolean) => void;
  isSyncingCatalog: boolean;
  syncFeedback: string | null;
  showAdvancedSource: boolean;
  setShowAdvancedSource: (show: boolean) => void;
  isCatalogSourceConfirming: boolean;
  setIsCatalogSourceConfirming: (confirming: boolean) => void;
  handleSyncCatalog: () => void;
  handleSaveCatalogSource: () => void;
  catalogUrlSaved: boolean;
}

export const NetworkDataSection: React.FC<NetworkDataSectionProps> = ({
  proxyInput,
  setProxyInput,
  isTestingProxy,
  proxyTestResult,
  proxySavedFeedback,
  highlightRow,
  activeNotice,
  handleTestProxy,
  handleSaveProxy,
  catalogSourceUrl,
  setCatalogSourceUrl,
  setCatalogUrlSaved,
  isSyncingCatalog,
  syncFeedback,
  showAdvancedSource,
  setShowAdvancedSource,
  isCatalogSourceConfirming,
  setIsCatalogSourceConfirming,
  handleSyncCatalog,
  handleSaveCatalogSource,
  catalogUrlSaved,
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-group">
      <div className="settings-group-title">
        <Globe size={15} strokeWidth={1.5} />
        <span>{t('settings.network_data', { defaultValue: '网络与数据' })}</span>
      </div>
      <div id="settings-account">
        <OAuthAccountCard />
      </div>

      <div className={`settings-row ${highlightRow === 'proxy' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.proxy_title')}</span>
            {proxyTestResult && (
              <span
                style={{
                  fontSize: 'var(--font-sm)',
                  fontWeight: 510,
                  color: !proxyTestResult.success ? '#ef4444' : proxyTestResult.latency_ms < 400 ? '#10b981' : proxyTestResult.latency_ms < 1000 ? '#f59e0b' : '#ea580c',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  whiteSpace: 'nowrap',
                }}
              >
                <span className={`status-dot ${!proxyTestResult.success ? 'status-dot-error' : proxyTestResult.latency_ms < 400 ? 'status-dot-success' : proxyTestResult.latency_ms < 1000 ? 'status-dot-warning' : 'status-dot-error'}`} />
                <span>{proxyTestResult.text}</span>
              </span>
            )}
            {proxySavedFeedback && (
              <span style={{ fontSize: 'var(--font-sm)', color: '#10b981', fontWeight: 500 }}>
                {proxySavedFeedback}
              </span>
            )}
            {activeNotice?.key === 'proxy' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>

        <div className="settings-input-group" style={{ maxWidth: '460px' }}>
          <input
            type="text"
            className={`settings-input ${highlightRow === 'proxy' ? 'input-highlight' : ''}`}
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder={t('settings.proxy_placeholder')}
          />
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={handleTestProxy}
            disabled={isTestingProxy}
          >
            {isTestingProxy ? <RotateCcw size={12} className="icon-spin" /> : <Zap size={12} />}
            <span>{isTestingProxy ? t('settings.testing_speed') : t('settings.test_speed')}</span>
          </button>
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={handleSaveProxy}
          >
            {t('settings.save_proxy')}
          </button>
        </div>
      </div>

      <div className={`settings-row ${highlightRow === 'catalog_source' || highlightRow === 'catalog_sync' ? 'row-highlight' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div className="settings-row-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 510 }}>{t('settings.catalog_sync_title')}</span>
              {(activeNotice?.key === 'catalog_source' || activeNotice?.key === 'catalog_sync') && (
                <span className="setting-applied-badge">
                  <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                  <span>{activeNotice.text}</span>
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: 'var(--font-sm)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={() => setShowAdvancedSource(!showAdvancedSource)}
            >
              {showAdvancedSource ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}
              <span>{showAdvancedSource ? t('settings.catalog_collapse_btn') : t('settings.catalog_custom_btn')}</span>
            </button>
            <button
              type="button"
              className="btn-fluent btn-primary"
              onClick={handleSyncCatalog}
              disabled={isSyncingCatalog}
              style={{ fontSize: 'var(--font-sm)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {isSyncingCatalog ? <RotateCcw size={14} strokeWidth={1.5} className="icon-spin" /> : <RefreshCw size={14} strokeWidth={1.5} />}
              <span>{isSyncingCatalog ? t('settings.catalog_syncing') : t('settings.catalog_sync_now')}</span>
            </button>
          </div>
        </div>

        {showAdvancedSource && (
          <div
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              padding: '8px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-acrylic-thin)',
              border: '1px solid var(--border-color)',
            }}
          >
            <input
              type="text"
              className="settings-input"
              value={catalogSourceUrl}
              onChange={(e) => {
                setCatalogSourceUrl(e.target.value);
                setCatalogUrlSaved(false);
                setIsCatalogSourceConfirming(false);
              }}
              placeholder="https://.../catalog.json"
            />
            {isCatalogSourceConfirming ? (
              <>
                <button
                  type="button"
                  className="btn-fluent"
                  style={{ fontSize: 'var(--font-sm)', padding: '0 12px', height: '32px', display: 'flex', alignItems: 'center', gap: '4px', background: '#ef4444', color: '#fff', fontWeight: 510, whiteSpace: 'nowrap' }}
                  onClick={handleSaveCatalogSource}
                >
                  <span>{t('settings.catalog_confirm_switch')}</span>
                </button>
                <button
                  type="button"
                  className="btn-fluent btn-secondary"
                  style={{ fontSize: 'var(--font-sm)', padding: '0 12px', height: '32px', whiteSpace: 'nowrap' }}
                  onClick={() => setIsCatalogSourceConfirming(false)}
                >
                  <span>{t('common.cancel')}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: 'var(--font-sm)', padding: '0 14px', height: '32px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}
                onClick={handleSaveCatalogSource}
              >
                {catalogUrlSaved && <Check size={12} />}
                <span>{catalogUrlSaved ? t('common.save') : t('settings.catalog_save_btn')}</span>
              </button>
            )}
          </div>
        )}
        {isCatalogSourceConfirming && (
          <span style={{ fontSize: 'var(--font-sm)', color: '#ef4444', fontWeight: 510 }}>
            {t('settings.catalog_warn_custom')}
          </span>
        )}

        {syncFeedback && (
          <span style={{ fontSize: 'var(--font-sm)', color: syncFeedback.includes('失败') ? '#ef4444' : '#10b981' }}>
            {syncFeedback}
          </span>
        )}
      </div>
    </div>
  );
};
