import React, { useMemo } from 'react';
import { marked } from 'marked';
import { api } from '../services/api';
import { sanitizeHtml } from '../utils/sanitize';

// GitHub Markdown 块级引用 Alerts 预处理器（支持 [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION]）
export function preprocessGitHubAlerts(markdown: string): string {
  if (!markdown || !markdown.includes('[!')) return markdown;
  const alertRegex = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\n]*\n((?:^>[^\n]*\n?)*)/gim;
  return markdown.replace(alertRegex, (_match, type, body) => {
    const alertType = type.toLowerCase();
    const cleanBody = body
      .split('\n')
      .map((line: string) => line.replace(/^>\s?/, ''))
      .join('\n')
      .trim();
    const titles: Record<string, string> = {
      note: '说明 (Note)',
      tip: '提示 (Tip)',
      important: '要点 (Important)',
      warning: '警告 (Warning)',
      caution: '注意 (Caution)',
    };
    const titleText = titles[alertType] || type;
    return `\n<div class="markdown-alert markdown-alert-${alertType}">\n<div class="markdown-alert-title">${titleText}</div>\n\n${cleanBody}\n\n</div>\n`;
  });
}

/**
 * AppDetailModal README concern: alert preprocessing, sanitized HTML,
 * link-click routing and image-fallback handling.
 * Pure move of the readme block previously inline in AppDetailModal.tsx.
 * No behavior change; prop surface of the modal is untouched.
 */
export function useDetailReadme(opts: {
  readmeMarkdown: string;
  owner: string;
  repo: string;
  forgeHost: string;
}) {
  const { readmeMarkdown, owner, repo, forgeHost } = opts;

  const { rawBaseUrl, repoBaseUrl } = useMemo(() => {
    const host = forgeHost || 'github.com';
    if (host.includes('github.com')) {
      return {
        rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`,
        repoBaseUrl: `https://github.com/${owner}/${repo}/blob/HEAD/`,
      };
    }
    return {
      rawBaseUrl: `https://${host}/${owner}/${repo}/raw/branch/main/`,
      repoBaseUrl: `https://${host}/${owner}/${repo}/src/branch/main/`,
    };
  }, [owner, repo, forgeHost]);

  // 避免高频下载进度事件重绘时重复同步解析庞大的 Markdown 文档阻塞渲染主线程，并执行严格 AST 级 XSS 净化与基准路径补全
  const readmeHtml = useMemo(() => {
    if (!readmeMarkdown) return '';
    const preprocessed = preprocessGitHubAlerts(readmeMarkdown);
    const rawParsed = marked.parse(preprocessed, {
      async: false,
      gfm: true,
      breaks: false,
    }) as string;
    return sanitizeHtml(rawParsed, { rawBaseUrl, repoBaseUrl });
  }, [readmeMarkdown, rawBaseUrl, repoBaseUrl]);

  // 拦截超链接点击：内部锚点平滑滚动定位，外链直通系统默认浏览器
  const handleReadmeClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;
    const href = target.getAttribute('href');
    if (!href) return;

    // 内部锚点平滑跳转
    if (href.startsWith('#')) {
      e.preventDefault();
      const anchorId = decodeURIComponent(href.slice(1));
      if (anchorId) {
        const targetEl =
          document.getElementById(anchorId) ||
          document.querySelector(`[name="${anchorId}"]`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
      return;
    }

    // 外部或仓库相对链接通过系统默认浏览器打开
    if (href.startsWith('http://') || href.startsWith('https://')) {
      e.preventDefault();
      e.stopPropagation();
      api.openUrl(href);
    }
  };

  // 智能图片错误容灾备用切换：当直连 raw.githubusercontent.com 遇到网络阻断时自动重试镜像代理，反之亦然
  const handleReadmeImageErrorCapture = (e: React.SyntheticEvent<HTMLDivElement, Event>) => {
    const target = e.target as HTMLElement;
    if (target.tagName.toLowerCase() !== 'img') return;
    const img = target as HTMLImageElement;
    const currentSrc = img.getAttribute('src') || '';
    if (!currentSrc || img.dataset.hasFallbackAttempted === 'true') {
      return;
    }

    // 1. 若经过 gh-proxy 的 raw 直链加载失败，尝试脱壳回退到官方直连
    if (currentSrc.startsWith('https://gh-proxy.com/https://raw.githubusercontent.com/')) {
      img.dataset.hasFallbackAttempted = 'true';
      img.src = currentSrc.replace('https://gh-proxy.com/', '');
      return;
    }

    // 2. 若 raw.githubusercontent.com 官方直连加载失败（常见于网络阻断或 DNS 污染），自动重试通过 gh-proxy 镜像拉取
    if (currentSrc.startsWith('https://raw.githubusercontent.com/')) {
      img.dataset.hasFallbackAttempted = 'true';
      img.src = `https://gh-proxy.com/${currentSrc}`;
      return;
    }

    // 3. 彻底无法加载时优雅降低可见度并标注悬浮提示，杜绝破损裂图破坏页面美观
    img.dataset.hasFallbackAttempted = 'true';
    img.style.opacity = '0.45';
    img.style.filter = 'grayscale(100%)';
    img.title = `图片暂无法加载: ${img.alt || currentSrc}`;
  };

  return { readmeHtml, handleReadmeClick, handleReadmeImageErrorCapture };
}
