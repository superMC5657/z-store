import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import { api, type ReadmeVariant } from '../services/api';
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

export type ReadmeLang = 'zh-CN' | 'en-US';

function defaultLangFromI18n(lng?: string): ReadmeLang {
  if (lng && lng.toLowerCase().startsWith('zh')) return 'zh-CN';
  return 'en-US';
}

// README 变体内存缓存：appId（小写）维度存 variants + mtime，TTL 复用详情 30min。
// 命中且未过期直接复用，不调 getReadmeVariants；语言切换只切 activeMarkdown，不触发重拉。
export const README_VARIANTS_TTL_MS = 30 * 60 * 1000;

interface ReadmeVariantsCacheEntry {
  variants: ReadmeVariant[];
  mtime: number;
}

const readmeVariantsCache = new Map<string, ReadmeVariantsCacheEntry>();

export function clearReadmeVariantsCache(appId?: string): void {
  if (appId) {
    const key = appId.trim().toLowerCase();
    readmeVariantsCache.delete(key);
  } else {
    readmeVariantsCache.clear();
  }
}

function readmeCacheKey(appId: string): string {
  return appId.trim().toLowerCase();
}

function normalizeReadmeVariants(input: unknown): ReadmeVariant[] {
  const list = Array.isArray(input)
    ? (input as ReadmeVariant[])
    : (input as { variants?: unknown } | null | undefined) &&
        Array.isArray((input as { variants?: unknown }).variants)
      ? ((input as { variants: ReadmeVariant[] }).variants as ReadmeVariant[])
      : [];
  return (list || []).filter(
    (v) =>
      v &&
      (v.lang === 'zh-CN' || v.lang === 'en-US') &&
      typeof v.markdown === 'string',
  );
}

/**
 * AppDetailModal README 关注点 Hook：警示框预处理、HTML 净化清洗、
 * 链接点击分流与图片回退兜底处理。
 * 纯粹提取原 AppDetailModal.tsx 内联的 README 处理逻辑代码块。
 * 无任何行为变更；弹窗组件对外属性保持原样。
 *
 * README 双语：经 get_readme_variants 拉取 zh-CN / en-US 变体，
 * 默认跟随界面语言（zh 开头选中中文，否则 EN），局部 state 切换，
 * 绝不调用 i18n.changeLanguage；缺变体时回退主 readme_markdown。
 */
export function useDetailReadme(opts: {
  readmeMarkdown: string;
  owner: string;
  repo: string;
  forgeHost: string;
  appId?: string;
  /** AppDetail 已携带的变体（若有则直接复用，不调 getReadmeVariants）。 */
  readmeVariants?: ReadmeVariant[];
  /** 缓存 TTL，默认复用详情 30min。 */
  variantsTtlMs?: number;
}) {
  const { readmeMarkdown, owner, repo, forgeHost, appId, readmeVariants, variantsTtlMs } = opts;
  const { i18n } = useTranslation();
  const uiLang = i18n?.language;

  const [variants, setVariants] = useState<ReadmeVariant[]>([]);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [readmeLang, setReadmeLangState] = useState<ReadmeLang>(() =>
    defaultLangFromI18n(uiLang),
  );
  // 用户手动切换后不再被自动归一化覆盖；appId / 界面语言变化时重置
  const hasUserSelectedRef = useRef(false);

  // appId 切换重置 + 界面语言切换默认跟随（局部 state，不动全局 i18n）
  useEffect(() => {
    hasUserSelectedRef.current = false;
    setReadmeLangState(defaultLangFromI18n(uiLang));
  }, [appId, uiLang]);

  // 变体拉取：AppDetail 自带 / 内存缓存命中（30min 内）直接复用，不调接口；
  // 失败静默回退主文档，不弹错；语言切换只改 activeMarkdown，不进此 effect
  useEffect(() => {
    let cancelled = false;
    if (!appId) {
      setVariants([]);
      setVariantsLoading(false);
      return;
    }
    const ttl = variantsTtlMs ?? README_VARIANTS_TTL_MS;
    const key = readmeCacheKey(appId);
    // 1. AppDetail 已带变体 → 直接复用并回填缓存
    const preset = normalizeReadmeVariants(readmeVariants);
    if (preset.length > 0) {
      setVariants(preset);
      setVariantsLoading(false);
      readmeVariantsCache.set(key, { variants: preset, mtime: Date.now() });
      return;
    }
    // 2. 内存缓存命中且未过期 → 直接复用（主 readme 已有且刚拉过同样走这里）
    const cached = readmeVariantsCache.get(key);
    if (cached && Date.now() - cached.mtime < ttl) {
      setVariants(cached.variants);
      setVariantsLoading(false);
      return;
    }
    setVariants([]);
    setVariantsLoading(true);
    (async () => {
      try {
        const res = (await (api as unknown as {
          getReadmeVariants?: (id: string) => Promise<unknown>;
        }).getReadmeVariants?.(appId)) as
          | { variants?: ReadmeVariant[] }
          | ReadmeVariant[]
          | null
          | undefined;
        if (cancelled) return;
        const list = normalizeReadmeVariants(res);
        setVariants(list);
        readmeVariantsCache.set(key, { variants: list, mtime: Date.now() });
      } catch {
        if (!cancelled) setVariants([]);
      } finally {
        if (!cancelled) setVariantsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId, readmeVariants, variantsTtlMs]);

  const hasZhVariant = useMemo(
    () => variants.some((v) => v.lang === 'zh-CN'),
    [variants],
  );
  const hasEnVariant = useMemo(
    () => variants.some((v) => v.lang === 'en-US'),
    [variants],
  );

  // 变体加载完成后归一化一次：当前选中无对应变体时回退到存在的那一侧，
  // 高亮与内容保持一致；用户手动选过后不再自动覆盖
  useEffect(() => {
    if (variantsLoading) return;
    if (hasUserSelectedRef.current) return;
    if (!appId) return;
    let desired: ReadmeLang | null = null;
    if (hasZhVariant && hasEnVariant) {
      desired = defaultLangFromI18n(uiLang);
    } else if (hasZhVariant && !hasEnVariant) {
      desired = 'zh-CN';
    } else if (!hasZhVariant && hasEnVariant) {
      desired = 'en-US';
    } else {
      return;
    }
    if (desired !== readmeLang) {
      setReadmeLangState(desired);
    }
  }, [variantsLoading, hasZhVariant, hasEnVariant, uiLang, appId, readmeLang]);

  const activeMarkdown = useMemo(() => {
    const hit = variants.find((v) => v.lang === readmeLang);
    if (hit && hit.markdown) return hit.markdown;
    return readmeMarkdown;
  }, [variants, readmeLang, readmeMarkdown]);

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
    if (!activeMarkdown) return '';
    const preprocessed = preprocessGitHubAlerts(activeMarkdown);
    const rawParsed = marked.parse(preprocessed, {
      async: false,
      gfm: true,
      breaks: false,
    }) as string;
    return sanitizeHtml(rawParsed, { rawBaseUrl, repoBaseUrl });
  }, [activeMarkdown, rawBaseUrl, repoBaseUrl]);

  const setReadmeLang = (lang: ReadmeLang) => {
    hasUserSelectedRef.current = true;
    setReadmeLangState(lang);
  };

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

  return {
    readmeHtml,
    handleReadmeClick,
    handleReadmeImageErrorCapture,
    readmeLang,
    setReadmeLang,
    hasZhVariant,
    hasEnVariant,
    isVariantsLoading: variantsLoading,
  };
}
