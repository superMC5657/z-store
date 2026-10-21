/**
 * Canonical App Id 前端归一口锁值（#35）：
 * `normalizeId` 升级为后端 `canonical_lookup_id` 同语义（可解析直取 canonical，
 * 不可解析回退小写），案例与 `src-tauri/src/forge/coord.rs` 单测同源——
 * 前后端键全同（ADR-0010）在此锁定。
 */
import { describe, expect, it } from 'vitest';
import { canonicalAppId, normalizeId, normalizeIdLowerSet, normalizeIdSet } from './normalizeId';

describe('normalizeId（canonical 深度，与后端 canonical_lookup_id 同值）', () => {
  it('裸 owner/repo 与大小写漂移归一', () => {
    expect(normalizeId('RustDesk/RustDesk')).toBe('rustdesk/rustdesk');
    expect(normalizeId('  Owner/Repo  ')).toBe('owner/repo');
    expect(normalizeId('owner/repo.git')).toBe('owner/repo');
    expect(normalizeId('https://github.com/RustDesk/RustDesk')).toBe('rustdesk/rustdesk');
  });

  it('GitHub 前缀别名折叠为裸 owner/repo（与后端 canonical 同值）', () => {
    expect(normalizeId('gh:Owner/Repo')).toBe('owner/repo');
    expect(normalizeId('github:Owner/Repo')).toBe('owner/repo');
    // id 键与坐标键收敛（#35 enrich merge miss 修复口径）
    expect(normalizeId('gh:Owner/Repo')).toBe(`${normalizeId('Owner')}/${normalizeId('Repo')}`);
  });

  it('非 GitHub forge 前缀保持带前缀 canonical', () => {
    expect(normalizeId('codeberg:FreeTubeApp/FreeTube')).toBe('codeberg:freetubeapp/freetube');
    expect(normalizeId('cb:O/R')).toBe('codeberg:o/r');
    expect(normalizeId('gitea:O/R')).toBe('gitea:o/r');
    expect(normalizeId('gt:git.example.com/O/R')).toBe('gitea:git.example.com/o/r');
    expect(normalizeId('gl:O/R')).toBe('gitlab:o/r');
  });

  it('完整 URL 宿主判 forge：白名单精确/子域，自建默认 gitea', () => {
    expect(normalizeId('https://codeberg.org/FreeTubeApp/FreeTube')).toBe('codeberg:freetubeapp/freetube');
    expect(normalizeId('https://gitlab.com/o/r')).toBe('gitlab:o/r');
    expect(normalizeId('https://api.github.com/o/r')).toBe('github:api.github.com/o/r');
    expect(normalizeId('https://git.example.com/o/r')).toBe('gitea:git.example.com/o/r');
    expect(normalizeId('https://xx-github.com/o/r')).toBe('gitea:xx-github.com/o/r');
  });

  it('宿主端口/尾点在白名单匹配前剥离（后端 matches_host 同口径）', () => {
    expect(normalizeId('https://github.com:443/o/r')).toBe('o/r');
    expect(normalizeId('https://github.com./o/r')).toBe('o/r');
    expect(normalizeId('https://api.github.com:443/o/r')).toBe('github:api.github.com:443/o/r');
    expect(normalizeId('https://git.example.com:8443/o/r')).toBe(
      'gitea:git.example.com:8443/o/r',
    );
  });

  it('不可解析回退小写（total 不断路由，同 canonical_lookup_id）', () => {
    expect(normalizeId('rustdesk')).toBe('rustdesk');
    expect(normalizeId('xyz:owner/repo')).toBe('xyz:owner/repo');
    expect(normalizeId('o/r r')).toBe('o/r r');
    expect(normalizeId('')).toBe('');
    expect(normalizeId('   ')).toBe('');
    expect(normalizeId(42)).toBe('');
    expect(normalizeId(null)).toBe('');
  });

  it('脏坐标段拒绝解析（回退小写，不产出 canonical）', () => {
    expect(normalizeId('o /r')).toBe('o /r');
    expect(normalizeId('o/r\\x')).toBe('o/r\\x');
  });

  it('repo 段 `?`/`#` 截断（后端分支 3 同清洗）', () => {
    expect(normalizeId('o/r?x=1')).toBe('o/r');
    expect(normalizeId('o/r#frag')).toBe('o/r');
  });
});

describe('canonicalAppId（Option 形态，门禁用）', () => {
  it('可解析返回 canonical，不可解析返回 null', () => {
    expect(canonicalAppId('gh:Owner/Repo')).toBe('owner/repo');
    expect(canonicalAppId('codeberg:O/R')).toBe('codeberg:o/r');
    expect(canonicalAppId('Owner/Repo')).toBe('owner/repo');
    expect(canonicalAppId('xyz:owner/repo')).toBeNull();
    expect(canonicalAppId('rustdesk')).toBeNull();
    expect(canonicalAppId('')).toBeNull();
    expect(canonicalAppId(42)).toBeNull();
  });
});

describe('normalizeIdSet / normalizeIdLowerSet（经 normalizeId 收敛去重）', () => {
  it('同仓异形归一同键去重', () => {
    expect(normalizeIdSet(['Owner/Repo', 'gh:owner/repo', 'o/r', ''])).toEqual([
      'owner/repo',
      'o/r',
    ]);
    expect(normalizeIdLowerSet(['RustDesk/RustDesk', 'rustdesk/rustdesk'])).toEqual(
      new Set(['rustdesk/rustdesk']),
    );
  });
});
