/**
 * 前端远端图片收敛：经后端 `fetch_or_cache_asset_url`（系统代理 + 30 天分片磁盘缓存）
 * 把远端 http(s) 图片换成可直接渲染的 `data:` URI，同一静态图只由后端获取一次。
 *
 * - 仅真实 Tauri 运行时生效（见 `tauriRuntime.isRealTauriRuntime`）；
 *   jsdom 单测与 Demo 预览保持原链同步直出。
 * - 有界内存缓存（条数 + 字符总量双上限，FIFO 淘汰）+ 同 URL 单飞。
 * - Markdown HTML：命中缓存同步直填；未命中先置透明占位（原址暂存 `data-zstore-src`，
 *   不挂远端 `src`），再以有界并发逐个解析回填。动态徽章（shields/camo/badge/workflow）原样直连。
 */
import { useEffect, useMemo, useState } from 'react';
import { tauriApi } from './api';
import { isRealTauriRuntime } from './tauriRuntime';

/** 1×1 透明 GIF：未解析图片的首屏占位，不触发任何网络请求。 */
export const ASSET_PLACEHOLDER_SRC =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const MAX_ENTRIES = 120;
/** `data:` 字符总量上限（约 48MB）：单图可达 5MB × base64 膨胀，仅按条数限不住内存。 */
const MAX_TOTAL_CHARS = 48 * 1024 * 1024;
/** README / 更新日志图片解析并发上限。 */
const ASSET_RESOLVE_CONCURRENCY = 4;
/** 渐进回填节流：避免每张图都整块重设 innerHTML。 */
const FLUSH_THROTTLE_MS = 200;

const PENDING_SRC_ATTR = 'data-zstore-src';
const PENDING_SRCSET_ATTR = 'data-zstore-srcset';

const resolvedAssetMemCache = new Map<string, string>();
let resolvedAssetChars = 0;
const inflightAssetPromises = new Map<string, Promise<string>>();

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 动态徽章：每次请求内容可能不同，与后端 `is_dynamic_asset_url` 同口径，保持直连。 */
function isDynamicAssetUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes('shields') ||
    lower.includes('camo') ||
    lower.includes('badge') ||
    lower.includes('workflow')
  );
}

/** 可经后端缓存的远端图片候选。 */
function isCacheableAssetUrl(url: string): boolean {
  const t = url.trim();
  return isHttpUrl(t) && !isDynamicAssetUrl(t);
}

function remember(url: string, uri: string): void {
  if (resolvedAssetMemCache.has(url)) return;
  resolvedAssetMemCache.set(url, uri);
  resolvedAssetChars += uri.length;
  while (
    resolvedAssetMemCache.size > MAX_ENTRIES ||
    (resolvedAssetChars > MAX_TOTAL_CHARS && resolvedAssetMemCache.size > 1)
  ) {
    const oldest = resolvedAssetMemCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    resolvedAssetChars -= resolvedAssetMemCache.get(oldest)?.length ?? 0;
    resolvedAssetMemCache.delete(oldest);
  }
}

/** 同步查内存缓存（0ms 首屏直填用）。 */
export function getSyncCachedAssetUri(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return resolvedAssetMemCache.get(url.trim());
}

/**
 * 解析远端图片为可渲染地址：`data:` URI（已缓存/新下载落盘）或回退原链。
 * 非真实 Tauri 运行时与非候选 URL 原样返回；同 URL 并发单飞，仅 `data:` 结果进内存缓存。
 */
export function resolveCachedAssetUri(url: string, appId?: string): Promise<string> {
  const key = url.trim();
  if (!key || !isRealTauriRuntime() || !isCacheableAssetUrl(key)) {
    return Promise.resolve(url);
  }
  const hit = resolvedAssetMemCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = inflightAssetPromises.get(key);
  if (inflight) return inflight;
  const p = tauriApi
    .fetchOrCacheAssetUrl(key, appId ?? '')
    .then((res) => {
      const out = typeof res === 'string' && res ? res : key;
      if (out.startsWith('data:')) remember(key, out);
      return out;
    })
    .catch(() => key)
    .finally(() => {
      inflightAssetPromises.delete(key);
    });
  inflightAssetPromises.set(key, p);
  return p;
}

export function __resetAssetCacheForTests(): void {
  resolvedAssetMemCache.clear();
  resolvedAssetChars = 0;
  inflightAssetPromises.clear();
}

interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

function parseSrcset(srcset: string): SrcsetCandidate[] {
  return srcset
    .split(',')
    .map((c) => c.trim().split(/\s+/))
    .filter((parts) => parts.length > 0 && parts[0])
    .map((parts) => ({ url: parts[0], descriptor: parts.slice(1).join(' ') }));
}

function buildSrcset(cands: SrcsetCandidate[], map: (url: string) => string): string {
  return cands
    .map((c) => (c.descriptor ? `${map(c.url)} ${c.descriptor}` : map(c.url)))
    .join(', ');
}

export interface PreparedMarkdownHtml {
  html: string;
  /** 待后端解析的唯一远端 URL（首屏未命中内存缓存者）。 */
  pending: string[];
}

/**
 * 首屏同步处理：命中内存缓存直填；未命中的可缓存图片置透明占位并暂存原址，
 * 保证 WebView 首屏不抢跑直连。无图或全部命中时原样（或已替换）返回。
 */
export function prepareInitialHtml(baseHtml: string): PreparedMarkdownHtml {
  if (!baseHtml || !baseHtml.includes('<img')) return { html: baseHtml, pending: [] };
  const doc = new DOMParser().parseFromString(baseHtml, 'text/html');
  const pending = new Set<string>();
  let changed = false;
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') || '').trim();
    if (src && isCacheableAssetUrl(src)) {
      const hit = getSyncCachedAssetUri(src);
      if (hit) {
        img.setAttribute('src', hit);
      } else {
        img.setAttribute(PENDING_SRC_ATTR, src);
        img.setAttribute('src', ASSET_PLACEHOLDER_SRC);
        pending.add(src);
      }
      changed = true;
    }
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const cands = parseSrcset(srcset);
      const remote = cands.filter((c) => isCacheableAssetUrl(c.url));
      if (remote.length > 0) {
        const misses = remote.filter((c) => !getSyncCachedAssetUri(c.url));
        if (misses.length === 0) {
          img.setAttribute('srcset', buildSrcset(cands, (u) => getSyncCachedAssetUri(u) ?? u));
        } else {
          // srcset 优先于 src：未解析前整体摘除，避免浏览器挑中远端候选直连。
          img.setAttribute(PENDING_SRCSET_ATTR, srcset);
          img.removeAttribute('srcset');
          for (const c of misses) pending.add(c.url);
        }
        changed = true;
      }
    }
  }
  return { html: changed ? doc.body.innerHTML : baseHtml, pending: Array.from(pending) };
}

/** 以已解析映射回填占位（未解析者保持占位，等待后续批次）。 */
function applyResolved(html: string, resolved: Map<string, string>): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll(`img[${PENDING_SRC_ATTR}]`))) {
    const orig = img.getAttribute(PENDING_SRC_ATTR) || '';
    const out = resolved.get(orig);
    if (out !== undefined) {
      img.setAttribute('src', out);
      img.removeAttribute(PENDING_SRC_ATTR);
    }
  }
  for (const img of Array.from(doc.querySelectorAll(`img[${PENDING_SRCSET_ATTR}]`))) {
    const cands = parseSrcset(img.getAttribute(PENDING_SRCSET_ATTR) || '');
    const ready = cands.every((c) => !isCacheableAssetUrl(c.url) || resolved.has(c.url));
    if (ready) {
      img.setAttribute('srcset', buildSrcset(cands, (u) => resolved.get(u) ?? u));
      img.removeAttribute(PENDING_SRCSET_ATTR);
    }
  }
  return doc.body.innerHTML;
}

/** 有界并发解析 `urls`，每完成一项经 `onResolved` 回调；全部完成（或取消）后 resolve。 */
async function resolveWithPool(
  urls: string[],
  appId: string | undefined,
  concurrency: number,
  onResolved: (url: string, out: string) => void,
  isCancelled: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length && !isCancelled()) {
      const url = urls[next++];
      const out = await resolveCachedAssetUri(url, appId);
      if (isCancelled()) return;
      onResolved(url, out);
    }
  };
  const n = Math.max(1, Math.min(concurrency, urls.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * Markdown HTML 图片收敛 Hook：真实 Tauri 运行时首屏不挂远端图片，
 * 后端解析完成后渐进回填 `data:`（或回退原链）；其余运行时原样返回。
 */
export function useResolvedMarkdownImages(baseHtml: string, appId?: string): string {
  const real = isRealTauriRuntime();
  const prepared = useMemo(
    () => (real ? prepareInitialHtml(baseHtml) : null),
    [real, baseHtml],
  );
  const [state, setState] = useState<{ base: string; html: string } | null>(null);

  useEffect(() => {
    if (!prepared || prepared.pending.length === 0) return;
    let cancelled = false;
    const resolved = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      if (cancelled) return;
      setState({ base: baseHtml, html: applyResolved(prepared.html, resolved) });
    };
    void resolveWithPool(
      prepared.pending,
      appId,
      ASSET_RESOLVE_CONCURRENCY,
      (url, out) => {
        resolved.set(url, out);
        if (resolved.size === prepared.pending.length) {
          if (timer) clearTimeout(timer);
          flush();
        } else if (!timer) {
          timer = setTimeout(flush, FLUSH_THROTTLE_MS);
        }
      },
      () => cancelled,
    );
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [prepared, baseHtml, appId]);

  if (!prepared) return baseHtml;
  if (state && state.base === baseHtml) return state.html;
  return prepared.html;
}
