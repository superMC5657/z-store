/** 待收录草稿表单上方的实时卡片预览窗口。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Eye, Globe, ShieldCheck, Tag } from 'lucide-react';
import { AppIconFrame } from '../../components/AppIconFrame';
import { PlatformIcon } from '../../components/icons/PlatformIcons';
import { formatPlatformLabels } from '../../lib/platformFilter';
import { formatHomepageDisplay } from '../../utils/appHelper';
import { resolvePendingDraftDescription, type PendingDraftItem } from './draftModel';

interface PendingPreviewLaneProps {
  form: PendingDraftItem;
  /** platforms 文本态归一后的平台列表（splitCsv(platformsText.toLowerCase())）。 */
  previewPlatforms: string[];
  /** owner/repo 推导的期望 id（id 为空时徽标展示）。 */
  expectedId: string;
  expanded: boolean;
  onToggle: () => void;
}

export const PendingPreviewLane: React.FC<PendingPreviewLaneProps> = ({
  form,
  previewPlatforms,
  expectedId,
  expanded,
  onToggle,
}) => {
  const { t, i18n } = useTranslation();
  const resolvedId = form.id.trim() || expectedId;
  const platformsLabel = t('pending.preview.platform_title', {
    platform: formatPlatformLabels(previewPlatforms),
  });

  return (
    <div className="pending-preview-lane">
      <div className="pending-preview-header">
        <div className="pending-preview-header-title">
          <Eye size={13} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <strong>{t('pending.preview.title')}</strong>
          {!expanded && resolvedId && (
            <span className="pending-preview-collapsed-meta">
              {resolvedId}
            </span>
          )}
          {t('pending.preview.hint') ? (
            <span className="pending-preview-header-hint">{t('pending.preview.hint')}</span>
          ) : null}
        </div>
        <div className="pending-preview-header-actions">
          <button
            type="button"
            className="btn-fluent btn-ghost btn-sm pending-preview-toggle-btn"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls="pending-preview-body"
          >
            {expanded ? (
              <>
                <ChevronUp size={12} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('pending.preview.collapse')}</span>
              </>
            ) : (
              <>
                <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('pending.preview.expand')}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div id="pending-preview-body" className="pending-preview-body">
          {/* 卡片主体：图标 + 标题 + owner/repo + 分类 + 平台 */}
          <div className="pending-preview-main">
            <AppIconFrame
              icon={form.icon.trim()}
              name={form.name.trim() || form.owner.trim() || resolvedId}
              appId={resolvedId}
              iconBg={form.icon_bg.trim() || undefined}
              size="md"
            />
            <div className="pending-preview-meta">
              <div className="pending-preview-title-row">
                <span className={`pending-preview-name ${!form.name.trim() ? 'pending-preview-empty' : ''}`}>
                  {form.name.trim() || t('pending.preview.empty_name')}
                </span>
                <span className="pending-preview-id-badge" title={resolvedId}>
                  {resolvedId || t('pending.preview.empty_id')}
                </span>
              </div>
              <div className="pending-preview-owner-row">
                {form.owner.trim() || form.repo.trim() ? (
                  <span>{form.owner.trim() || '—'} / {form.repo.trim() || '—'}</span>
                ) : (
                  <span className="pending-preview-empty">{t('pending.preview.empty_repo')}</span>
                )}
                <span className="pending-item-dot" />
                <span className={!form.category.trim() ? 'pending-preview-empty' : ''}>
                  {form.category_name.trim() || form.category.trim() || t('pending.preview.empty_category')}
                </span>
                {form.default_version.trim() && (
                  <>
                    <span className="pending-item-dot" />
                    <span>{form.default_version.trim()}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 描述：按当前语言取 description/description_en，空回退另一语言，两空复用 trends.no_desc */}
          {(() => {
            const previewDesc = resolvePendingDraftDescription(form, i18n.language);
            return (
              <p className={`pending-preview-desc ${!previewDesc ? 'pending-preview-empty' : ''}`}>
                {previewDesc || t('trends.no_desc')}
              </p>
            );
          })()}

          {/* 底部信息标签栏 */}
          <div className="pending-preview-tags">
            {/* 分类标签 */}
            <span className={`pending-preview-tag ${!form.category.trim() ? 'pending-preview-empty' : ''}`} title={t('pending.preview.category_title')}>
              <Tag size={10} strokeWidth={1.5} aria-hidden="true" />
              <span>{form.category_name.trim() || form.category.trim() || t('pending.preview.empty_category')}</span>
            </span>

            {/* 开源协议标签 */}
            <span className={`pending-preview-tag ${!form.license.trim() ? 'pending-preview-empty' : ''}`} title={t('pending.preview.license_title')}>
              <ShieldCheck size={11} strokeWidth={1.5} aria-hidden="true" />
              <span>{form.license.trim() || t('pending.preview.empty_license')}</span>
            </span>

            {/* 平台标签：与详情页同形，全部平台图标合并为一枚，平台名在悬停提示 */}
            {previewPlatforms.length > 0 ? (
              <span
                className="pending-preview-tag"
                data-testid="pending-preview-platforms"
                title={platformsLabel}
                role="img"
                aria-label={platformsLabel}
              >
                {previewPlatforms.map((p) => (
                  <PlatformIcon key={p} platform={p} size={11} />
                ))}
              </span>
            ) : (
              <span className="pending-preview-tag pending-preview-empty">{t('pending.preview.empty_platforms')}</span>
            )}

            {/* 官网/主页标签 */}
            {form.homepage.trim() ? (
              <span className="pending-preview-tag" title={t('pending.preview.homepage_title', { homepage: form.homepage })}>
                <Globe size={11} strokeWidth={1.5} aria-hidden="true" />
                <a
                  href={form.homepage.trim()}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ color: 'inherit', textDecoration: 'none' }}
                >
                  {formatHomepageDisplay(form.homepage)}
                </a>
              </span>
            ) : (
              <span className="pending-preview-tag pending-preview-empty">{t('pending.preview.empty_homepage')}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
