/**
 * 详情顶栏「官方主页」外链决议：仓库地址构造、http(s) 安全校验与仓库自链判重。
 */
import { describe, expect, it } from 'vitest';
import { buildAppRepoUrl, formatHomepageDisplay, resolveExternalHomepageUrl } from './appHelper';

describe('formatHomepageDisplay', () => {
  it.each([
    ['https://zed.dev', 'zed.dev'],
    ['  https://www.dshtui.com/  ', 'dshtui.com'],
    ['HTTPS://WWW.Example.com', 'Example.com'],
    ['https://demo.example.org/docs?ref=zstore#top', 'demo.example.org/docs'],
    ['https://github.com/apps/desktop//', 'github.com/apps/desktop'],
    ['http://localhost:8080/app', 'localhost:8080/app'],
    ['https://例子.测试/路径', '例子.测试/路径'],
  ])('%j → %j', (url, expected) => {
    expect(formatHomepageDisplay(url)).toBe(expected);
  });

  it('草稿中尚无协议头的输入照常裁剪展示', () => {
    expect(formatHomepageDisplay('example.com/no-scheme/')).toBe('example.com/no-scheme');
  });

  it.each([null, undefined, '', '   '])('空值 %j 返回空串', (url) => {
    expect(formatHomepageDisplay(url)).toBe('');
  });
});

describe('buildAppRepoUrl', () => {
  it('forge_host 为空或缺失时回退 github.com', () => {
    expect(buildAppRepoUrl({ forge_host: null, owner: 'o', repo: 'r' })).toBe('https://github.com/o/r');
    expect(buildAppRepoUrl({ forge_host: '  ', owner: 'o', repo: 'r' })).toBe('https://github.com/o/r');
    expect(buildAppRepoUrl({ owner: 'o', repo: 'r' })).toBe('https://github.com/o/r');
  });

  it('非 GitHub 托管与自建端口实例', () => {
    expect(buildAppRepoUrl({ forge_host: 'codeberg.org', owner: 'o', repo: 'r' })).toBe('https://codeberg.org/o/r');
    expect(buildAppRepoUrl({ forge_host: 'gitlab.com', owner: 'o', repo: 'r' })).toBe('https://gitlab.com/o/r');
    expect(buildAppRepoUrl({ forge_host: 'git.example.com:8443', owner: 'org', repo: 'app' })).toBe(
      'https://git.example.com:8443/org/app',
    );
  });

  it('剥除 forge_host 误带的协议头与尾斜杠', () => {
    expect(buildAppRepoUrl({ forge_host: 'HTTPS://codeberg.org/', owner: 'o', repo: 'r' })).toBe(
      'https://codeberg.org/o/r',
    );
    expect(buildAppRepoUrl({ forge_host: 'http://gitlab.com//', owner: ' /o/ ', repo: 'r/' })).toBe(
      'https://gitlab.com/o/r',
    );
  });

  it('owner 或 repo 为空返回空串', () => {
    expect(buildAppRepoUrl({ owner: '', repo: 'r' })).toBe('');
    expect(buildAppRepoUrl({ owner: 'o', repo: '  ' })).toBe('');
    expect(buildAppRepoUrl({ owner: null, repo: null })).toBe('');
  });
});

describe('resolveExternalHomepageUrl：独立主页正常展示', () => {
  const gh = (owner: string, repo: string) => `https://github.com/${owner}/${repo}`;

  it('标准官网保留原文（含尾斜杠策略）', () => {
    expect(resolveExternalHomepageUrl('https://rustdesk.com', gh('rustdesk', 'rustdesk'))).toBe('https://rustdesk.com');
    expect(resolveExternalHomepageUrl('https://www.videolan.org/vlc/', gh('videolan', 'vlc'))).toBe(
      'https://www.videolan.org/vlc/',
    );
    expect(resolveExternalHomepageUrl('http://gitup.co', gh('git-up', 'GitUp'))).toBe('http://gitup.co');
  });

  it('去首尾空白并把大写协议头归一为小写', () => {
    expect(resolveExternalHomepageUrl('  HTTPS://Example.com/docs?lang=zh#intro  ', gh('o', 'r'))).toBe(
      'https://Example.com/docs?lang=zh#intro',
    );
  });

  it('同主机不同路径不判重', () => {
    expect(resolveExternalHomepageUrl('https://github.com/apps/desktop', gh('desktop', 'desktop'))).toBe(
      'https://github.com/apps/desktop',
    );
    expect(resolveExternalHomepageUrl('https://github.com/owner/repo/wiki', gh('owner', 'repo'))).toBe(
      'https://github.com/owner/repo/wiki',
    );
  });

  it('跨托管平台与 GitHub Pages 不判重', () => {
    expect(resolveExternalHomepageUrl('https://gitlab.com/OpenMW/openmw', gh('OpenMW', 'openmw'))).toBe(
      'https://gitlab.com/OpenMW/openmw',
    );
    expect(
      resolveExternalHomepageUrl('https://clash-verge-rev.github.io', gh('clash-verge-rev', 'clash-verge-rev')),
    ).toBe('https://clash-verge-rev.github.io');
  });
});

describe('resolveExternalHomepageUrl：非法输入返回 null', () => {
  const repo = 'https://github.com/o/r';

  it('空值与非字符串', () => {
    for (const v of [null, undefined, '', '   ', 42, {}, ['https://zed.dev']]) {
      expect(resolveExternalHomepageUrl(v, repo)).toBeNull();
    }
  });

  it('无协议、相对路径、语法损坏与内部空白', () => {
    for (const v of ['zed.dev', '/docs', 'https://', 'http://[bad', 'https://zed.dev (official)']) {
      expect(resolveExternalHomepageUrl(v, repo)).toBeNull();
    }
  });

  it('非 http(s) 协议', () => {
    for (const v of [
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'vbscript:msgbox(1)',
      'mailto:hi@example.com',
      'ftp://files.example.com',
      'file:///C:/test',
      'zstore://app/o/r',
    ]) {
      expect(resolveExternalHomepageUrl(v, repo)).toBeNull();
    }
  });

  it('内嵌凭据与单段占位主机', () => {
    expect(resolveExternalHomepageUrl('https://github.com@evil.example.com', repo)).toBeNull();
    expect(resolveExternalHomepageUrl('https://none', repo)).toBeNull();
  });

  it('localhost 与 IPv6 主机合法', () => {
    expect(resolveExternalHomepageUrl('http://localhost:3000', repo)).toBe('http://localhost:3000');
    expect(resolveExternalHomepageUrl('http://[::1]:8080/', repo)).toBe('http://[::1]:8080/');
  });
});

describe('resolveExternalHomepageUrl：指向当前仓库自身返回 null', () => {
  const ripgrep = 'https://github.com/burntsushi/ripgrep';

  it('GitHub 同仓地址的各种写法', () => {
    for (const hp of [
      'https://github.com/burntsushi/ripgrep',
      'https://github.com/BurntSushi/ripgrep',
      'https://github.com/BurntSushi/ripgrep/',
      'https://github.com/BurntSushi/ripgrep///',
      'http://github.com/BurntSushi/ripgrep',
      'https://www.github.com/BurntSushi/ripgrep',
      'https://github.com/BurntSushi/ripgrep.git',
      'https://github.com/BurntSushi/ripgrep#readme',
      'https://github.com/BurntSushi/ripgrep?tab=readme-ov-file',
      'https://github.com:443/BurntSushi/ripgrep',
      'http://github.com:80/BurntSushi/ripgrep',
    ]) {
      expect(resolveExternalHomepageUrl(hp, ripgrep)).toBeNull();
    }
  });

  it('Codeberg 与自建端口实例', () => {
    expect(
      resolveExternalHomepageUrl('https://codeberg.org/FreeTubeApp/FreeTube/', 'https://codeberg.org/FreeTubeApp/FreeTube'),
    ).toBeNull();
    expect(
      resolveExternalHomepageUrl('https://git.example.com:8443/Org/Repo', 'https://git.example.com:8443/org/repo'),
    ).toBeNull();
    expect(
      resolveExternalHomepageUrl('https://git.example.com:9443/org/repo', 'https://git.example.com:8443/org/repo'),
    ).toBe('https://git.example.com:9443/org/repo');
  });
});
