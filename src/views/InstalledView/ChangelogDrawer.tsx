import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { marked } from 'marked';
import { ExternalLink } from 'lucide-react';
import type { UpdateItem } from '../../types';
import { sanitizeHtml } from '../../utils/sanitize';
import { useResolvedMarkdownImages } from '../../services/assetCache';

interface ChangelogDrawerProps {
  update: UpdateItem;
  onOpenDetail?: () => void;
}

/** 已装行下方展开的更新日志：版本区间标题 + 净化后的 Markdown；无日志时给出去详情页看 Release 的提示。 */
export const ChangelogDrawer: React.FC<ChangelogDrawerProps> = ({ update, onOpenDetail }) => {
  const { t } = useTranslation();
  const html = useMemo(() => {
    const text = update.changelog?.trim();
    return text ? sanitizeHtml(marked.parse(update.changelog, { async: false }) as string) : null;
  }, [update.changelog]);
  // 更新日志插图经后端缓存收敛（真实 Tauri 下首屏不挂远端图片）。
  const resolvedHtml = useResolvedMarkdownImages(html ?? '', update.app_id);

  return (
    <div className="manage-changelog-drawer">
      <div className="manage-changelog-header">
        <span>
          {t('installed.changelog_header', {
            current: update.current_version,
            latest: update.latest_version,
          })}
        </span>
        {onOpenDetail && (
          <button type="button" className="manage-inline-link-btn" onClick={onOpenDetail}>
            <ExternalLink size={11} strokeWidth={1.5} />
            <span>{t('installed.open_app_detail')}</span>
          </button>
        )}
      </div>
      {html ? (
        <div className="manage-changelog-scroll">
          <div className="readme-markdown-body" dangerouslySetInnerHTML={{ __html: resolvedHtml }} />
        </div>
      ) : (
        <div className="manage-changelog-empty">
          <span>{t('installed.changelog_empty')}</span>
        </div>
      )}
    </div>
  );
};
