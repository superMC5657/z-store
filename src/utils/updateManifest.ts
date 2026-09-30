/**
 * 双区更新清单解析器（官网独立仓库与应用端共用模块）
 *
 * 定位：
 * - 纯 TypeScript 模块，零第三方依赖，零 @tauri-apps 依赖，支持浏览器/Node/Tauri 等全环境。
 * - 官网独立仓库（z-store-landing 等）可直接复制/vendor 本文件使用。
 *
 * 清单结构与 CI 产物对应关系：
 * - latest.json: 海外直链版，platforms 条目为 { url, signature }，URL 为 GitHub 直链。
 * - latest-cn.json: 国内 gh-proxy 镜像版，platforms 条目扩展 { url, signature, name, size, sha256 }，URL 携带镜像前缀。
 *
 * 回落链顺序（永不 reject，静默回退）：
 * 1. 本区清单（cn: 经镜像拉取 latest-cn.json；global: 直链拉取 latest.json）
 * 2. 对方清单（cn: 直链拉取 latest.json；global: 直链拉取 latest-cn.json）
 * 3. GitHub Releases API（cn: 经镜像拉取；global: 直链拉取；解析并过滤非安装包资产）
 * 4. 兜底终点：GitHub Releases 网页地址（不发请求）
 */

export type UpdateRegion = 'cn' | 'global';
export const DEFAULT_MIRROR_PREFIX = 'https://gh-proxy.com/';
export const ZSTORE_REPO = 'superMC5657/z-store';

export interface UpdateManifestPlatform {
  url: string;
  signature: string;
  name?: string;
  size?: number;
  sha256?: string;
}

export interface UpdateManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, UpdateManifestPlatform>;
}

export type UpdateFeedResult =
  | { source: 'manifest'; region: UpdateRegion; manifest: UpdateManifest }
  | { source: 'releases-api'; manifest: UpdateManifest }
  | { source: 'releases-page'; url: string };

const CN_TIMEZONES = new Set([
  'Asia/Shanghai',
  'Asia/Urumqi',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Kashgar',
]);

/**
 * 根据时区与语言信号推断目标区域。
 * 时区属于中国大陆集合或主语言为 zh-CN / zh-Hans* 时判定为 'cn'，其余判定为 'global'。
 */
export function detectRegionFromSignals(signals: {
  timeZone?: string | null;
  languages?: readonly string[] | null;
}): UpdateRegion {
  if (signals.timeZone && CN_TIMEZONES.has(signals.timeZone)) {
    return 'cn';
  }
  const primaryLang = signals.languages?.[0];
  if (primaryLang) {
    const normalized = primaryLang.toLowerCase();
    if (normalized === 'zh-cn' || normalized.startsWith('zh-hans')) {
      return 'cn';
    }
  }
  return 'global';
}

/**
 * 运行时自动嗅探环境区域，环境缺失时安全回落至 'global'。
 */
export function detectRegion(): UpdateRegion {
  let timeZone: string | undefined;
  let languages: readonly string[] | undefined;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
  } catch {
    // 忽略环境缺失/异常
  }
  try {
    if (typeof navigator !== 'undefined' && Array.isArray(navigator.languages)) {
      languages = navigator.languages;
    }
  } catch {
    // 忽略环境缺失/异常
  }
  return detectRegionFromSignals({ timeZone, languages });
}

/**
 * 构造仓库最新 Releases 页面地址。
 */
export function releasesPageUrl(repo: string): string {
  const cleanRepo = repo.replace(/^\/+|\/+$/g, '');
  return `https://github.com/${cleanRepo}/releases/latest`;
}

export interface ResolveUpdateFeedOptions {
  repo: string;
  region?: UpdateRegion;      // 缺省 detectRegion()
  mirrorPrefix?: string;      // 缺省 DEFAULT_MIRROR_PREFIX
  fetchImpl?: typeof fetch;   // 缺省 globalThis.fetch（须 typeof 守卫）
  timeoutMs?: number;         // 缺省 15000，单请求超时
}

function isIgnoredAsset(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const ignoredSuffixes = [
    '.sig',
    '.sha256',
    '.json',
    '.yml',
    '.yaml',
    '.txt',
    '.md',
    '.blockmap',
  ];
  if (ignoredSuffixes.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  if (lower.includes('checksums') || lower.includes('sha256sums')) {
    return true;
  }
  return false;
}

async function fetchWithTimeout(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchFn(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function tryFetchManifest(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  region: UpdateRegion,
): Promise<UpdateFeedResult | null> {
  try {
    const res = await fetchWithTimeout(url, fetchFn, timeoutMs);
    if (!res.ok) {
      return null;
    }
    const raw = (await res.json()) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const data = raw as Record<string, unknown>;
    if (typeof data.version !== 'string' || !data.version.trim()) {
      return null;
    }
    if (!data.platforms || typeof data.platforms !== 'object' || Array.isArray(data.platforms)) {
      return null;
    }
    const platformObj = data.platforms as Record<string, unknown>;
    const keys = Object.keys(platformObj);
    if (keys.length === 0) {
      return null;
    }
    const validatedPlatforms: Record<string, UpdateManifestPlatform> = {};
    for (const key of keys) {
      const entry = platformObj[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const p = entry as Record<string, unknown>;
      if (typeof p.url !== 'string' || !p.url.trim() || typeof p.signature !== 'string' || !p.signature.trim()) {
        return null;
      }
      validatedPlatforms[key] = {
        url: p.url,
        signature: p.signature,
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
        ...(typeof p.size === 'number' ? { size: p.size } : {}),
        ...(typeof p.sha256 === 'string' ? { sha256: p.sha256 } : {}),
      };
    }

    const manifest: UpdateManifest = {
      version: data.version,
      ...(typeof data.notes === 'string' ? { notes: data.notes } : {}),
      ...(typeof data.pub_date === 'string' ? { pub_date: data.pub_date } : {}),
      platforms: validatedPlatforms,
    };

    return {
      source: 'manifest',
      region,
      manifest,
    };
  } catch {
    return null;
  }
}

async function tryFetchReleasesApi(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  region: UpdateRegion,
  mirrorPrefix: string,
): Promise<UpdateFeedResult | null> {
  try {
    const res = await fetchWithTimeout(url, fetchFn, timeoutMs);
    if (!res.ok) {
      return null;
    }
    const raw = (await res.json()) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const data = raw as Record<string, unknown>;
    if (typeof data.tag_name !== 'string' || !data.tag_name.trim()) {
      return null;
    }
    if (!Array.isArray(data.assets)) {
      return null;
    }
    const rawAssets = data.assets as unknown[];
    const productAssets: Array<{ name: string; browser_download_url: string; size?: number }> = [];

    for (const item of rawAssets) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const asset = item as Record<string, unknown>;
      if (typeof asset.name !== 'string' || !asset.name.trim()) continue;
      if (typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.trim()) continue;
      if (isIgnoredAsset(asset.name)) continue;

      productAssets.push({
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        ...(typeof asset.size === 'number' ? { size: asset.size } : {}),
      });
    }

    if (productAssets.length === 0) {
      return null;
    }

    const version = data.tag_name.trim().replace(/^v/i, '');
    const notes = typeof data.body === 'string' ? data.body : undefined;
    const platforms: Record<string, UpdateManifestPlatform> = {};

    for (const asset of productAssets) {
      const urlWithPrefix = region === 'cn' ? `${mirrorPrefix}${asset.browser_download_url}` : asset.browser_download_url;
      platforms[asset.name] = {
        url: urlWithPrefix,
        signature: '',
        name: asset.name,
        ...(asset.size !== undefined ? { size: asset.size } : {}),
      };
    }

    return {
      source: 'releases-api',
      manifest: {
        version,
        ...(notes !== undefined ? { notes } : {}),
        platforms,
      },
    };
  } catch {
    return null;
  }
}

/**
 * 按区域与镜像回落链解析最新安装包信息。
 * 永不 reject，最终兜底为 releases 页面地址。
 */
export async function resolveUpdateFeed(options: ResolveUpdateFeedOptions): Promise<UpdateFeedResult> {
  const cleanRepo = options.repo.replace(/^\/+|\/+$/g, '');
  const region = options.region ?? detectRegion();
  const rawMirror = options.mirrorPrefix ?? DEFAULT_MIRROR_PREFIX;
  const m = rawMirror.endsWith('/') ? rawMirror : `${rawMirror}/`;
  const timeoutMs = options.timeoutMs ?? 15000;
  const fetchFn = options.fetchImpl ?? (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined);

  if (!fetchFn) {
    return {
      source: 'releases-page',
      url: releasesPageUrl(cleanRepo),
    };
  }

  // 1. 本区清单
  const step1Url = region === 'cn'
    ? `${m}https://github.com/${cleanRepo}/releases/latest/download/latest-cn.json`
    : `https://github.com/${cleanRepo}/releases/latest/download/latest.json`;
  const step1Res = await tryFetchManifest(step1Url, fetchFn, timeoutMs, region);
  if (step1Res) {
    return step1Res;
  }

  // 2. 对方清单
  const step2Url = region === 'cn'
    ? `https://github.com/${cleanRepo}/releases/latest/download/latest.json`
    : `https://github.com/${cleanRepo}/releases/latest/download/latest-cn.json`;
  const step2Res = await tryFetchManifest(step2Url, fetchFn, timeoutMs, region);
  if (step2Res) {
    return step2Res;
  }

  // 3. Releases API
  const step3Url = region === 'cn'
    ? `${m}https://api.github.com/repos/${cleanRepo}/releases/latest`
    : `https://api.github.com/repos/${cleanRepo}/releases/latest`;
  const step3Res = await tryFetchReleasesApi(step3Url, fetchFn, timeoutMs, region, m);
  if (step3Res) {
    return step3Res;
  }

  // 4. 终点：Releases 网页
  return {
    source: 'releases-page',
    url: releasesPageUrl(cleanRepo),
  };
}
