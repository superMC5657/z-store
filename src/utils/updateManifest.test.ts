/**
 * 双区更新清单解析与回落链契约测试
 */
import { describe, expect, it, vi } from 'vitest';
import {
  detectRegion,
  detectRegionFromSignals,
  releasesPageUrl,
  resolveUpdateFeed,
  DEFAULT_MIRROR_PREFIX,
  ZSTORE_REPO,
  type UpdateManifest,
} from './updateManifest';

describe('detectRegionFromSignals', () => {
  it('时区属于中国大陆集合时判定为 cn', () => {
    expect(detectRegionFromSignals({ timeZone: 'Asia/Shanghai' })).toBe('cn');
    expect(detectRegionFromSignals({ timeZone: 'Asia/Urumqi' })).toBe('cn');
    expect(detectRegionFromSignals({ timeZone: 'Asia/Chongqing' })).toBe('cn');
    expect(detectRegionFromSignals({ timeZone: 'Asia/Harbin' })).toBe('cn');
    expect(detectRegionFromSignals({ timeZone: 'Asia/Kashgar' })).toBe('cn');
  });

  it('海外时区判定为 global', () => {
    expect(detectRegionFromSignals({ timeZone: 'America/New_York' })).toBe('global');
    expect(detectRegionFromSignals({ timeZone: 'Europe/London' })).toBe('global');
    expect(detectRegionFromSignals({ timeZone: 'Asia/Tokyo' })).toBe('global');
  });

  it('主语言为 zh-CN 时判定为 cn', () => {
    expect(detectRegionFromSignals({ languages: ['zh-CN', 'en-US'] })).toBe('cn');
    expect(detectRegionFromSignals({ languages: ['zh-Hans-CN'] })).toBe('cn');
  });

  it('主语言为 zh-TW 等非大陆中文时判定为 global', () => {
    expect(detectRegionFromSignals({ languages: ['zh-TW', 'zh-CN'] })).toBe('global');
    expect(detectRegionFromSignals({ languages: ['zh-HK'] })).toBe('global');
  });

  it('空信号安全默认判定为 global', () => {
    expect(detectRegionFromSignals({})).toBe('global');
    expect(detectRegionFromSignals({ timeZone: null, languages: null })).toBe('global');
  });
});

describe('detectRegion 环境嗅探', () => {
  it('正常执行不抛出异常并返回合法区域', () => {
    const region = detectRegion();
    expect(['cn', 'global']).toContain(region);
  });
});

describe('releasesPageUrl', () => {
  it('正确拼接 latest release 页面 URL', () => {
    expect(releasesPageUrl(ZSTORE_REPO)).toBe('https://github.com/superMC5657/z-store/releases/latest');
    expect(releasesPageUrl('/owner/repo/')).toBe('https://github.com/owner/repo/releases/latest');
  });
});

describe('resolveUpdateFeed 回落链契约', () => {
  it('cn 主路径：首请求镜像 latest-cn.json 成功并透传扩展字段', async () => {
    const mockManifest: UpdateManifest = {
      version: '1.2.0',
      notes: '更新内容说明',
      pub_date: '2026-09-29T00:00:00Z',
      platforms: {
        'windows-x86_64': {
          url: `${DEFAULT_MIRROR_PREFIX}https://github.com/superMC5657/z-store/releases/download/v1.2.0/z-store-setup.exe`,
          signature: 'MOCK_SIGNATURE',
          name: 'z-store-setup.exe',
          size: 10485760,
          sha256: 'abc123def456',
        },
      },
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      expect(url).toBe(`${DEFAULT_MIRROR_PREFIX}https://github.com/superMC5657/z-store/releases/latest/download/latest-cn.json`);
      return {
        ok: true,
        status: 200,
        json: async () => mockManifest,
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'cn',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      source: 'manifest',
      region: 'cn',
      manifest: mockManifest,
    });
  });

  it('global 主路径：首请求 GitHub 直链 latest.json 成功', async () => {
    const mockManifest: UpdateManifest = {
      version: '1.2.0',
      platforms: {
        'windows-x86_64': {
          url: 'https://github.com/superMC5657/z-store/releases/download/v1.2.0/z-store-setup.exe',
          signature: 'MOCK_SIGNATURE',
        },
      },
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      expect(url).toBe('https://github.com/superMC5657/z-store/releases/latest/download/latest.json');
      return {
        ok: true,
        status: 200,
        json: async () => mockManifest,
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'global',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      source: 'manifest',
      region: 'global',
      manifest: mockManifest,
    });
  });

  it('cn 失败回落：首清单 404 → 第二请求 GitHub 直链 latest.json 成功', async () => {
    const mockGlobalManifest: UpdateManifest = {
      version: '1.2.0',
      platforms: {
        'windows-x86_64': {
          url: 'https://github.com/superMC5657/z-store/releases/download/v1.2.0/z-store-setup.exe',
          signature: 'SIG_GLOBAL',
        },
      },
    };

    const calledUrls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (calledUrls.length === 1) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => mockGlobalManifest,
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'cn',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(calledUrls).toEqual([
      `${DEFAULT_MIRROR_PREFIX}https://github.com/superMC5657/z-store/releases/latest/download/latest-cn.json`,
      'https://github.com/superMC5657/z-store/releases/latest/download/latest.json',
    ]);
    expect(result).toEqual({
      source: 'manifest',
      region: 'cn',
      manifest: mockGlobalManifest,
    });
  });

  it('global 失败回落：直链 latest.json 网络异常 → 直链 latest-cn.json 成功（不经镜像）', async () => {
    const mockCnManifest: UpdateManifest = {
      version: '1.2.0',
      platforms: {
        'windows-x86_64': {
          url: `${DEFAULT_MIRROR_PREFIX}https://github.com/superMC5657/z-store/releases/download/v1.2.0/z-store-setup.exe`,
          signature: 'SIG_CN',
        },
      },
    };

    const calledUrls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (calledUrls.length === 1) {
        throw new Error('Network error');
      }
      return {
        ok: true,
        status: 200,
        json: async () => mockCnManifest,
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'global',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(calledUrls).toEqual([
      'https://github.com/superMC5657/z-store/releases/latest/download/latest.json',
      'https://github.com/superMC5657/z-store/releases/latest/download/latest-cn.json',
    ]);
    expect(result).toEqual({
      source: 'manifest',
      region: 'global',
      manifest: mockCnManifest,
    });
  });

  it('双清单皆败 → Releases API：cn 经镜像拉取且过滤非产物资产', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (calledUrls.length <= 2) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v2.0.1',
          body: '更新日志说明',
          assets: [
            {
              name: 'setup.exe',
              browser_download_url: 'https://github.com/superMC5657/z-store/releases/download/v2.0.1/setup.exe',
              size: 204800,
            },
            {
              name: 'setup.exe.sig',
              browser_download_url: 'https://github.com/superMC5657/z-store/releases/download/v2.0.1/setup.exe.sig',
              size: 128,
            },
            {
              name: 'latest.json',
              browser_download_url: 'https://github.com/superMC5657/z-store/releases/download/v2.0.1/latest.json',
              size: 512,
            },
            {
              name: 'checksums.txt',
              browser_download_url: 'https://github.com/superMC5657/z-store/releases/download/v2.0.1/checksums.txt',
              size: 256,
            },
          ],
        }),
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'cn',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(calledUrls[2]).toBe(`${DEFAULT_MIRROR_PREFIX}https://api.github.com/repos/superMC5657/z-store/releases/latest`);
    expect(result).toEqual({
      source: 'releases-api',
      manifest: {
        version: '2.0.1',
        notes: '更新日志说明',
        platforms: {
          'setup.exe': {
            url: `${DEFAULT_MIRROR_PREFIX}https://github.com/superMC5657/z-store/releases/download/v2.0.1/setup.exe`,
            signature: '',
            name: 'setup.exe',
            size: 204800,
          },
        },
      },
    });
  });

  it('三步皆败 → releases-page：返回 releases URL 且第 4 步无任何 fetch', async () => {
    let fetchCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'cn',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchCount).toBe(3);
    expect(result).toEqual({
      source: 'releases-page',
      url: 'https://github.com/superMC5657/z-store/releases/latest',
    });
  });

  it('首清单返回 200 但缺 platforms → 视为失败进入第二步', async () => {
    const calledUrls: string[] = [];
    const validManifest: UpdateManifest = {
      version: '1.0.0',
      platforms: {
        'windows-x86_64': {
          url: 'https://example.com/app.exe',
          signature: 'SIG',
        },
      },
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (calledUrls.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: '1.0.0' }), // 缺 platforms
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => validManifest,
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'cn',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(calledUrls).toHaveLength(2);
    expect(result).toEqual({
      source: 'manifest',
      region: 'cn',
      manifest: validManifest,
    });
  });

  it('超时路径：fetchImpl 收到 signal 后模拟 AbortError 能够被静默处理并继续回落', async () => {
    const validManifest: UpdateManifest = {
      version: '1.0.0',
      platforms: {
        'windows-x86_64': {
          url: 'https://example.com/app.exe',
          signature: 'SIG',
        },
      },
    };

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            json: async () => validManifest,
          });
        }, 50);

        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    });

    // timeoutMs 设为 5ms 触发中止，第一步超时后第二步成功
    let step = 0;
    const steppedFetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      step++;
      if (step === 1) {
        return fetchMock(url, init);
      }
      return {
        ok: true,
        status: 200,
        json: async () => validManifest,
      };
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'cn',
      timeoutMs: 5,
      fetchImpl: steppedFetchMock as unknown as typeof fetch,
    });

    expect(steppedFetchMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('manifest');
  });

  it('releases API 响应 200 但 assets 全为非产物 → 视为失败进入 releases-page', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.5.0',
          assets: [
            { name: 'app.sig', browser_download_url: 'https://example.com/app.sig' },
            { name: 'latest.json', browser_download_url: 'https://example.com/latest.json' },
            { name: 'sha256sums.txt', browser_download_url: 'https://example.com/sha256sums.txt' },
          ],
        }),
      };
    });

    // 清单两步都 404，API 全为非产物
    let callIndex = 0;
    const mockDispatcher = vi.fn().mockImplementation(async (url: string) => {
      callIndex++;
      if (callIndex <= 2) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }
      return fetchMock(url);
    });

    const result = await resolveUpdateFeed({
      repo: ZSTORE_REPO,
      region: 'cn',
      fetchImpl: mockDispatcher as unknown as typeof fetch,
    });

    expect(result).toEqual({
      source: 'releases-page',
      url: 'https://github.com/superMC5657/z-store/releases/latest',
    });
  });
});
