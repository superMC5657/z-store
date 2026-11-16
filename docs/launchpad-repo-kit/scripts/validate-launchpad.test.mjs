import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLaunchpad } from './validate-launchpad.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validate-launchpad.mjs');

export function makeItem(overrides = {}) {
  return {
    id: 'acme/hyper-term',
    name: 'HyperTerm',
    owner: 'acme',
    repo: 'hyper-term',
    forge: 'github',
    forge_host: 'github.com',
    icon: '',
    icon_bg: '',
    description: 'GPU terminal',
    maker_note: '重写了 WebGPU 渲染管线。',
    maker: { login: 'acme', avatar_url: 'https://avatars.githubusercontent.com/u/1', html_url: 'https://github.com/acme' },
    category: 'dev',
    category_name: '开发编程',
    license: 'MIT',
    latest_version: 'v0.4.2',
    platforms: ['windows', 'linux'],
    stars: 420,
    stars_7d_delta: 35,
    forks: 10,
    launched_at: '2027-01-10T00:00:00Z',
    discussion_repo: 'superMC5657/z-store-launchpad',
    discussion_number: 1,
    discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/1',
    discussion_comments_count: 3,
    discussion_upvotes: 9,
    ...overrides,
  };
}

function manifest(items, pinned = []) {
  return {
    version: 1,
    generated_at: '2027-01-15T00:00:00Z',
    discussions_repo: 'superMC5657/z-store-launchpad',
    pinned,
    items,
  };
}

const pin = (id, order = 1) => ({ id, pin_until: '2027-02-01T00:00:00Z', pin_tier: 'sponsor', pin_order: order });

const codeberg = makeItem({
  id: 'codeberg:pix/palette',
  owner: 'pix',
  repo: 'palette',
  forge: 'codeberg',
  forge_host: 'codeberg.org',
  license: 'MPL-2.0',
  discussion_number: 2,
  discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/2',
});
const selfHosted = makeItem({
  id: 'gitea:git.example.org/team/tool',
  owner: 'team',
  repo: 'tool',
  forge: 'gitea',
  forge_host: 'git.example.org',
  discussion_number: 3,
  discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/3',
});

test('合法清单（含置顶与多托管源）通过', () => {
  assert.deepEqual(validateLaunchpad(manifest([makeItem(), codeberg, selfHosted], [pin('acme/hyper-term')])), []);
});

test('pinned 超过 4 条被拦截', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((n, i) =>
    makeItem({ id: `acme/${n}`, repo: n, discussion_number: i + 1, discussion_url: `https://github.com/o/r/discussions/${i + 1}` }),
  );
  const errors = validateLaunchpad(manifest(items, items.map((it, i) => pin(it.id, Math.min(i + 1, 4)))));
  assert.ok(errors.some((e) => e.includes('至多 4 条')), errors.join('\n'));
});

test('pinned 引用不存在的 id 与重复 id 被拦截', () => {
  const errors = validateLaunchpad(manifest([makeItem()], [pin('ghost/none'), pin('acme/hyper-term', 2), pin('acme/hyper-term', 3)]));
  assert.ok(errors.some((e) => e.includes('引用不存在')));
  assert.ok(errors.some((e) => e.includes('pinned[2].id: 重复')));
});

test('items 重复 id 与推导不一致的 id 被拦截', () => {
  const errors = validateLaunchpad(manifest([makeItem(), makeItem(), makeItem({ id: 'acme/other' })]));
  assert.ok(errors.some((e) => e.includes('重复 acme/hyper-term')));
  assert.ok(errors.some((e) => e.includes('应为 acme/hyper-term')));
});

test('data: 与 http:// 图标被拦截', () => {
  const errors = validateLaunchpad(manifest([makeItem({ icon: 'data:image/png;base64,AAAA' })]));
  assert.ok(errors.some((e) => e.includes('.icon')));
  assert.ok(validateLaunchpad(manifest([makeItem({ icon: 'http://x/i.png' })])).some((e) => e.includes('.icon')));
});

test('非 OSI 协议（BUSL-1.1 / NOASSERTION）被拦截', () => {
  for (const license of ['BUSL-1.1', 'NOASSERTION']) {
    const errors = validateLaunchpad(manifest([makeItem({ license })]));
    assert.ok(errors.some((e) => e.includes('OSI')), license);
  }
});

test('超 140 字或含换行的 maker_note 被拦截', () => {
  assert.ok(validateLaunchpad(manifest([makeItem({ maker_note: '字'.repeat(141) })])).some((e) => e.includes('maker_note')));
  assert.ok(validateLaunchpad(manifest([makeItem({ maker_note: 'a\nb' })])).some((e) => e.includes('换行')));
  assert.deepEqual(validateLaunchpad(manifest([makeItem({ maker_note: '字'.repeat(140) })])), []);
});

test('非法时间、未知平台与非标准分类被拦截', () => {
  const errors = validateLaunchpad(
    manifest([makeItem({ launched_at: 'yesterday', platforms: ['beos'], category: 'misc' })]),
  );
  assert.ok(errors.some((e) => e.includes('launched_at')));
  assert.ok(errors.some((e) => e.includes('未知平台')));
  assert.ok(errors.some((e) => e.includes('非标准分类')));
});

test('CLI 校验失败以非 0 退出码结束，通过时退出码为 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-'));
  const bad = path.join(dir, 'bad.json');
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(bad, JSON.stringify(manifest([makeItem({ license: 'BUSL-1.1' })])));
  fs.writeFileSync(good, JSON.stringify(manifest([makeItem()])));
  assert.equal(spawnSync(process.execPath, [SCRIPT, bad]).status, 1);
  assert.equal(spawnSync(process.execPath, [SCRIPT, good]).status, 0);
});
