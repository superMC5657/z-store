import React, { useMemo } from 'react';
import { tauriApi } from '../../services/api';
import { renderDiscussionMarkdown } from './discussionFormat';

/** 讨论正文渲染：链接与图片点击统一经系统浏览器打开（仅 http/https）。 */
export const DiscussionMarkdown: React.FC<{ body: string; className?: string }> = ({ body, className }) => {
  const html = useMemo(() => renderDiscussionMarkdown(body), [body]);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a');
    const href = anchor ? anchor.getAttribute('href') : target.tagName === 'IMG' ? target.getAttribute('src') : null;
    if (!anchor && target.tagName !== 'IMG') return;
    e.preventDefault();
    if (href && /^https?:\/\//i.test(href)) void tauriApi.openUrl(href);
  };
  if (!html) return null;
  return (
    <div
      className={`readme-markdown-body launchpad-markdown ${className ?? ''}`.trim()}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
