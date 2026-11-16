import { describe, expect, it, vi } from 'vitest';
import {
  hashSeeded01,
  rankFeed,
  starsForksBase,
  subscribeAffinityUpdated,
} from './feed';
import type { AppSummary } from '../types';

function makeApp(id: string, stars: number): AppSummary {
  const [owner = 'acme', ...rest] = id.split('/');
  const repo = rest.join('/') || id;
  return {
    id,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    description: `${id} desc`,
    stars,
    forks: 0,
    license: 'MIT',
    latest_version: 'latest',
    category: 'dev',
    category_name: 'dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  };
}

describe('feed FNV-1a 64 对齐（前后端哈希逐位一致）', () => {
  // Golden：后端 src-tauri/src/github/catalog_feed_score.rs::fnv1a64_with_seed
  // h = OFFSET(0xcbf29ce484222325) ^ seed 起步，UTF-8 字节迭代，雪崩 h>>33 单乘法，除数 2^64。
  // 以下 hex/jitter 由后端同式独立算出，前端 BigInt 实现必须逐位一致。
  it('FNV golden：同一 (id, seed) 与后端同值', () => {
    expect(hashSeeded01('a/b', 0)).toBe(0.8121563068844255);
    expect(hashSeeded01('rustdesk/rustdesk', 0)).toBe(0.16280688745814842);
    expect(hashSeeded01('acme/atlas', 0)).toBe(0.19098578839770444);
    expect(hashSeeded01('acme/atlas', 42)).toBe(0.025868932759030218);
  });

  it('id 大小写归一（与后端 to_lowercase 对齐）', () => {
    expect(hashSeeded01('Acme/Atlas', 0)).toBe(hashSeeded01('acme/atlas', 0));
    expect(hashSeeded01('ACME/ATLAS', 7)).toBe(hashSeeded01('acme/atlas', 7));
  });

  it('换 seed 即换 jitter，范围恒 [0,1)', () => {
    const a = hashSeeded01('acme/atlas', 0);
    const b = hashSeeded01('acme/atlas', 42);
    expect(a).not.toBe(b);
    for (const v of [a, b, hashSeeded01('x/y', 123)]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('rankFeed tie-break 按 id 升序（与后端 then_with(id) 对齐）', () => {
    // stars 策略忽略 seed：同星即同分，tie 必须按 id 升序而非入参顺序
    const apps = [makeApp('acme/zebra', 100), makeApp('acme/apple', 100), makeApp('acme/mango', 100)];
    const ranked = rankFeed(apps, 0, 'stars');
    expect(ranked.map((a) => a.id)).toEqual(['acme/apple', 'acme/mango', 'acme/zebra']);
  });

  it('rankFeed 自定义 scorer 同分亦按 id 升序', () => {
    const apps = [makeApp('b/b', 10), makeApp('a/a', 10)];
    const ranked = rankFeed(apps, 0, 'balanced', () => 1);
    expect(ranked.map((a) => a.id)).toEqual(['a/a', 'b/b']);
  });
});

describe('starsForksBase 与画像更新订阅', () => {
  it('starsForksBase 在 forks=0 时退化为 ln(stars+1)，有 forks 时附加对数加成', () => {
    const base0 = starsForksBase({ ...makeApp('a/b', 1000), forks: 0 });
    expect(base0).toBeCloseTo(Math.log1p(1000), 10);
    const baseWithForks = starsForksBase({ ...makeApp('a/b', 1000), forks: 200 });
    expect(baseWithForks).toBeCloseTo(Math.log1p(1000) + 0.25 * Math.log1p(200), 10);
  });

  it('subscribeAffinityUpdated 可监听 zstore:affinity-updated 事件并正确解绑', () => {
    const onUpdate = vi.fn();
    const unsub = subscribeAffinityUpdated(onUpdate);
    window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    unsub();
    window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
