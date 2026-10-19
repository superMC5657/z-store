/**
 * AppIcon 渲染契约：
 * `resolveActiveIcon`（override > store > 缓冲 > prop，空亦覆盖）；
 * `resolveDisplaySrc`（空徽章 / `data:` 与 override 直显 / 双键缓存回读）；
 * `isRemoteIcon` 仅认前缀 + 扩展名收尾，不做子串匹配。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  AppIcon,
  getInitials,
  isRemoteIcon,
  resolveActiveIcon,
  resolveDisplaySrc,
} from './AppIcon';
import {
  __resetIconStoreForTests,
  __setIconDataCacheForTests,
  admitIconHit,
} from '../services/iconStore';

beforeEach(() => __resetIconStoreForTests());
afterEach(() => cleanup());

describe('resolveActiveIcon', () => {
  it('iconOverride 优先于一切（含空切徽章）', () => {
    expect(resolveActiveIcon('https://o/r.png', 'https://s/r.png', 'https://b/r.png', 'https://p/r.png')).toBe(
      'https://o/r.png',
    );
    expect(resolveActiveIcon('', 'https://s/r.png', 'https://b/r.png', 'https://p/r.png')).toBe('');
  });

  it('store > 缓冲 > prop', () => {
    expect(resolveActiveIcon(undefined, 'https://s/r.png', 'https://b/r.png', 'https://p/r.png')).toBe(
      'https://s/r.png',
    );
    expect(resolveActiveIcon(undefined, '', 'https://b/r.png', 'https://p/r.png')).toBe('');
    expect(resolveActiveIcon(undefined, undefined, 'https://b/r.png', 'https://p/r.png')).toBe(
      'https://b/r.png',
    );
    expect(resolveActiveIcon(undefined, undefined, undefined, 'https://p/r.png')).toBe('https://p/r.png');
  });
});

describe('resolveDisplaySrc', () => {
  it('空恒空（徽章）', () => {
    expect(resolveDisplaySrc('', false, 'o/r')).toBe('');
  });

  it('data: 直显', () => {
    expect(resolveDisplaySrc('data:image/png;base64,AAA', false, 'o/r')).toBe('data:image/png;base64,AAA');
  });

  it('override 直显（不查缓存）', () => {
    const url = 'https://cdn.example.com/o.png';
    __setIconDataCacheForTests(url, 'data:image/png;base64,CACHED');
    expect(resolveDisplaySrc(url, true, 'o/r')).toBe(url);
  });

  it('按 URL 键命中缓存即直显', () => {
    const url = 'https://cdn.example.com/u.png';
    __setIconDataCacheForTests(url, 'data:image/png;base64,CACHED');
    expect(resolveDisplaySrc(url, false, 'o/r')).toBe('data:image/png;base64,CACHED');
  });

  it('按归一 id 键命中缓存即直显', () => {
    const url = 'https://cdn.example.com/i.png';
    __setIconDataCacheForTests('o/r', 'data:image/png;base64,BYID');
    expect(resolveDisplaySrc(url, false, 'o/r')).toBe('data:image/png;base64,BYID');
  });

  it('皆无命中回落原值', () => {
    const url = 'https://cdn.example.com/m.png';
    expect(resolveDisplaySrc(url, false, 'o/r')).toBe(url);
  });
});

describe('isRemoteIcon', () => {
  it('远端与 data-uri 为真', () => {
    expect(isRemoteIcon('https://cdn.simpleicons.org/r')).toBe(true);
    expect(isRemoteIcon('http://example.com/a.png')).toBe(true);
    expect(isRemoteIcon('data:image/png;base64,AAA')).toBe(true);
  });

  it('裸路径按扩展名收尾判定', () => {
    expect(isRemoteIcon('icon.png')).toBe(true);
    expect(isRemoteIcon('/assets/a.svg?v=1')).toBe(true);
    expect(isRemoteIcon('  ICON.JPG  ')).toBe(true);
  });

  it('非图与空为假，不再 includes 误判', () => {
    expect(isRemoteIcon('')).toBe(false);
    expect(isRemoteIcon(undefined)).toBe(false);
    expect(isRemoteIcon(null)).toBe(false);
    expect(isRemoteIcon('📦')).toBe(false);
    expect(isRemoteIcon('not-an-icon')).toBe(false);
    expect(isRemoteIcon('foo.png-evil')).toBe(false);
  });
});

describe('getInitials', () => {
  it('空回退包裹徽章', () => {
    expect(getInitials('')).toBe('📦');
    expect(getInitials('  --  ')).toBe('📦');
  });

  it('多词取前两词首字母', () => {
    expect(getInitials('Visual Studio Code')).toBe('VS');
    expect(getInitials('LocalSend')).not.toBe('📦');
  });

  it('驼峰取前两段首字母，余下取前两字', () => {
    expect(getInitials('RustDesk')).toBe('RD');
    expect(getInitials('abc')).toBe('AB');
    expect(getInitials('A')).toBe('A');
  });
});

describe('<AppIcon/> 展示分支', () => {
  it('空图标走首字母徽章', () => {
    const { container } = render(<AppIcon icon="" name="RustDesk" appId="o/r" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.app-icon-fallback-badge')?.textContent).toBe('RD');
  });

  it('远端图标直出 img', () => {
    const { container } = render(
      <AppIcon icon="https://cdn.simpleicons.org/r" name="OR" appId="o/r" />,
    );
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('data-uri 直出 img', () => {
    const { container } = render(<AppIcon icon="data:image/png;base64,AAA" name="OR" appId="o/r" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('override 切空恒徽章（不复活 prop 旧图）', () => {
    const { container } = render(
      <AppIcon icon="https://cdn.simpleicons.org/r" name="RustDesk" appId="o/r" iconOverride="" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.app-icon-fallback-badge')?.textContent).toBe('RD');
  });

  it('M1 缓冲首绘回读：空 prop 即出 img', () => {
    const res = admitIconHit({
      id: 'o/r',
      icon: 'https://cdn.simpleicons.org/r',
      level: 2,
      via: 'live',
      context: { kind: 'search' },
    });
    expect(res.accepted).toBe(true);
    const { container } = render(<AppIcon icon="" name="OR" appId="o/r" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('非图非空走 emoji', () => {
    const { container } = render(<AppIcon icon="📦" name="OR" appId="o/r" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.app-icon-emoji')?.textContent).toBe('📦');
  });
});
