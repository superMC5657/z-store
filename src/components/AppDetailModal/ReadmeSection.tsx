import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppDetailViewModel } from '../../types';
import { useDetailReadme } from './useDetailReadme';

interface ReadmeSectionProps {
  app: AppDetailViewModel;
  displayDesc: string;
  showSkeleton: boolean;
  onRetry?: (id: string) => void;
}

export const ReadmeSection: React.FC<ReadmeSectionProps> = ({
  app,
  displayDesc,
  showSkeleton,
  onRetry,
}) => {
  const { t } = useTranslation();

  // README 文档渲染（见 useDetailReadme，含 zh-CN / en-US 变体局部切换）
  // AppDetail 若已带 readme_variants 则直接复用，不重调 getReadmeVariants；语言切换只切 activeMarkdown
  const {
    readmeHtml,
    handleReadmeClick,
    handleReadmeImageErrorCapture,
    readmeLang,
    setReadmeLang,
    hasZhVariant,
    hasEnVariant,
    isVariantsLoading,
  } = useDetailReadme({
    readmeMarkdown: app.readme_markdown,
    owner: app.owner,
    repo: app.repo,
    forgeHost: app.forge_host,
    appId: app.id,
    readmeVariants: (app as unknown as { readme_variants?: import('../../services/api').ReadmeVariant[] }).readme_variants,
  });

  return (
    <div className="readme-preview">
      {app.loadError ? (
        <div style={{ padding: '36px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 'calc(15px * var(--font-scale))', color: 'var(--status-warning)', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <AlertTriangle size={15} />
            <span>{t('detail.readme.load_failed', { error: app.loadError })}</span>
          </div>
          {onRetry && (
            <button
              type="button"
              className="btn-fluent btn-secondary btn-compact"
              onClick={() => onRetry(app.id)}
            >
              <RotateCcw size={13} />
              <span>{t('detail.readme.retry')}</span>
            </button>
          )}
        </div>
      ) : (
        <>
          <div
            className="readme-lang-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
              marginBottom: '12px',
            }}
          >
            <div
              style={{
                flex: '1 1 160px',
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <h4
                style={{
                  margin: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                README
              </h4>
            </div>
            <div
              role="group"
              aria-label={t('readme.lang_switch_label')}
              title={t('readme.lang_switch_label')}
              style={{
                display: 'flex',
                gap: '4px',
                flexShrink: 0,
                marginLeft: 'auto',
              }}
            >
              <button
                type="button"
                className={`btn-fluent btn-sm ${readmeLang === 'zh-CN' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setReadmeLang('zh-CN')}
                disabled={!hasZhVariant || isVariantsLoading}
                aria-pressed={readmeLang === 'zh-CN'}
                aria-label={`${t('readme.lang_switch_label')}: ${t('readme.lang_zh')}`}
                title={t('readme.lang_zh')}
                style={{ minWidth: '56px' }}
              >
                <span>{t('readme.lang_zh')}</span>
              </button>
              <button
                type="button"
                className={`btn-fluent btn-sm ${readmeLang === 'en-US' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setReadmeLang('en-US')}
                disabled={!hasEnVariant || isVariantsLoading}
                aria-pressed={readmeLang === 'en-US'}
                aria-label={`${t('readme.lang_switch_label')}: ${t('readme.lang_en')}`}
                title={t('readme.lang_en')}
                style={{ minWidth: '56px' }}
              >
                <span>{t('readme.lang_en')}</span>
              </button>
            </div>
          </div>
          {app.isLoading && !readmeHtml ? (
            showSkeleton ? (
              <div style={{ padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div className="skeleton-box" style={{ width: '38%', height: '24px' }} />
                <div className="skeleton-box" style={{ width: '95%', height: '14px' }} />
                <div className="skeleton-box" style={{ width: '82%', height: '14px' }} />
                <div className="skeleton-box" style={{ width: '88%', height: '14px' }} />
                <div className="skeleton-box" style={{ width: '60%', height: '14px' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px', color: 'var(--text-tertiary)', fontSize: 'var(--font-base)' }}>
                  <span className="spinner-icon" />
                  <span>{t('detail.readme.loading_doc')}</span>
                </div>
              </div>
            ) : (
              <div style={{ padding: '28px 24px', color: 'var(--text-tertiary)', fontSize: 'var(--font-base)', lineHeight: '1.6' }}>
                {displayDesc}
              </div>
            )
          ) : (
            <div
              className="readme-markdown-body"
              dangerouslySetInnerHTML={{ __html: readmeHtml }}
              onClick={handleReadmeClick}
              onErrorCapture={handleReadmeImageErrorCapture}
            />
          )}
        </>
      )}
    </div>
  );
};
