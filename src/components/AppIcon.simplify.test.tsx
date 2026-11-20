/** 测试 `AppIcon` 的图标解析优先级、本地缓存回读及远端地址判定逻辑。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
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

  it('网络波动导致远端 img onError 后，本地缓存 data: 就绪时自动清除 hasError 并恢复显示图标', () => {
    const remoteUrl = 'https://cdn.simpleicons.org/flaky';
    const cachedDataUri = 'data:image/png;base64,LOCALCACHE';
    const { container } = render(<AppIcon icon={remoteUrl} name="FlakyApp" appId="acme/flaky" />);
    const imgBefore = container.querySelector('img');
    expect(imgBefore).not.toBeNull();

    // 模拟网络波动导致浏览器直接加载远端 URL 失败
    act(() => {
      fireEvent.error(imgBefore!);
    });
    expect(container.querySelector('.app-icon-fallback-badge')?.textContent).toBe('FA');

    // 随后本地磁盘缓存读取完成写入 iconDataCache，组件自动重绘并清除错误态
    act(() => {
      __setIconDataCacheForTests(remoteUrl, cachedDataUri);
    });
    const imgAfter = container.querySelector('img');
    expect(imgAfter).not.toBeNull();
    expect(imgAfter?.getAttribute('src')).toBe(cachedDataUri);
    expect(container.querySelector('.app-icon-fallback-badge')).toBeNull();
  });

  it('支持 fit="contain" 与 insetPadding 光学留白（默认仍为 cover）', () => {
    const { container: defaultContainer } = render(
      <AppIcon icon="https://cdn.simpleicons.org/r" name="DefaultFit" appId="o/d" />,
    );
    const defaultImg = defaultContainer.querySelector('img') as HTMLImageElement;
    expect(defaultImg.style.objectFit).toBe('cover');

    const { container: containContainer } = render(
      <AppIcon
        icon="https://cdn.simpleicons.org/r"
        name="ContainFit"
        appId="o/c"
        fit="contain"
        insetPadding={4}
      />,
    );
    const containImg = containContainer.querySelector('img') as HTMLImageElement;
    expect(containImg.style.objectFit).toBe('contain');
    const box = containContainer.querySelector('.app-icon-container') as HTMLElement;
    expect(box.style.padding).toBe('4px');
  });

  it('insetPadding 下首字母徽章同样内缩为铺回退色的内块，容器不铺底色', () => {
    const { container } = render(
      <AppIcon icon="" name="tensorfold" appId="o/t" iconBg="rgb(1, 2, 3)" insetPadding={3} />,
    );
    const box = container.querySelector('.app-icon-container') as HTMLElement;
    const badge = container.querySelector('.app-icon-fallback-badge') as HTMLElement;
    expect(box.style.padding).toBe('3px');
    expect(box.style.background).toBe('transparent');
    expect(badge.style.background).toBe('rgb(1, 2, 3)');
    expect(badge.style.width).toBe('100%');
  });

  it('insetPadding 下 emoji 兜底同样内缩为铺回退色的内块', () => {
    const { container } = render(
      <AppIcon icon="📦" name="Box" appId="o/b" iconBg="rgb(1, 2, 3)" insetPadding={3} />,
    );
    const box = container.querySelector('.app-icon-container') as HTMLElement;
    const emoji = container.querySelector('.app-icon-emoji') as HTMLElement;
    expect(box.style.background).toBe('transparent');
    expect(emoji.style.background).toBe('rgb(1, 2, 3)');
    expect(emoji.style.width).toBe('100%');
  });

  it('未设 insetPadding 时首字母徽章仍满框铺回退色', () => {
    const { container } = render(
      <AppIcon icon="" name="tensorfold" appId="o/t" iconBg="rgb(1, 2, 3)" />,
    );
    const box = container.querySelector('.app-icon-container') as HTMLElement;
    const badge = container.querySelector('.app-icon-fallback-badge') as HTMLElement;
    expect(box.style.padding).toBe('');
    expect(box.style.background).toBe('rgb(1, 2, 3)');
    expect(badge.style.background).toBe('');
  });
});

describe('AppIcon 加载占位', () => {
  it('图片解码前垫首字母占位，加载完成即撤下，且不计入失败徽章', () => {
    const { container } = render(
      <AppIcon icon="https://cdn.example.com/rd.png" name="RustDesk" appId="rustdesk/rustdesk" />,
    );
    const placeholder = container.querySelector('.app-icon-placeholder');
    expect(placeholder?.textContent).toBe('RD');
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.app-icon-fallback-badge')).toBeNull();

    const img = container.querySelector('img.app-icon-image') as HTMLImageElement;
    act(() => {
      fireEvent.load(img);
    });
    expect(container.querySelector('.app-icon-placeholder')).toBeNull();
    expect(container.querySelector('img.app-icon-image')).toBe(img);
  });
});
