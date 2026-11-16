import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLaunch, discussionTitle, dropExpiredPins, labelToPin, renderShareKit } from './publish-launch.mjs';
import { validateLaunchpad } from './validate-launchpad.mjs';
import { makeItem } from './validate-launchpad.test.mjs';

const NOW = Date.parse('2027-01-15T00:00:00Z');

function base(items = [], pinned = []) {
  return { version: 1, generated_at: '2027-01-01T00:00:00Z', discussions_repo: 'superMC5657/z-store-launchpad', pinned, items };
}

function itemN(n) {
  return makeItem({
    id: `acme/app${n}`,
    repo: `app${n}`,
    discussion_number: n,
    discussion_url: `https://github.com/superMC5657/z-store-launchpad/discussions/${n}`,
  });
}

const pin = (id, until, order) => ({ id, pin_until: until, pin_tier: 'sponsor', pin_order: order });

test('标签映射置顶参数', () => {
  assert.equal(labelToPin('approved'), null);
  assert.deepEqual(labelToPin('pinned-14d'), { tier: 'sponsor', days: 14 });
  assert.deepEqual(labelToPin('featured-7d'), { tier: 'featured', days: 7 });
});

test('坑位已满时拒绝置顶并给出最早释放时间', () => {
  const items = [1, 2, 3, 4].map(itemN);
  const pinned = [
    pin('acme/app1', '2027-01-20T00:00:00Z', 1),
    pin('acme/app2', '2027-01-18T00:00:00Z', 2),
    pin('acme/app3', '2027-02-01T00:00:00Z', 3),
    pin('acme/app4', '2027-01-25T00:00:00Z', 4),
  ];
  const res = applyLaunch(base(items, pinned), itemN(5), { label: 'pinned-7d', nowMs: NOW });
  assert.equal(res.status, 'slots_full');
  assert.equal(res.earliestRelease, '2027-01-18T00:00:00Z');
  // approved 不受坑位限制
  assert.equal(applyLaunch(base(items, pinned), itemN(5), { label: 'approved', nowMs: NOW }).status, 'ok');
});

test('过期坑位先清理再计数，新置顶补位', () => {
  const items = [1, 2, 3, 4].map(itemN);
  const pinned = [
    pin('acme/app1', '2027-01-10T00:00:00Z', 1),
    pin('acme/app2', '2027-01-18T00:00:00Z', 2),
    pin('acme/app3', '2027-02-01T00:00:00Z', 3),
    pin('acme/app4', '2027-01-25T00:00:00Z', 4),
  ];
  const res = applyLaunch(base(items, pinned), itemN(5), { label: 'featured-7d', nowMs: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(res.manifest.pinned.length, 4);
  assert.deepEqual(res.manifest.pinned.map((p) => p.pin_order), [1, 2, 3, 4]);
  assert.deepEqual(res.pin, { id: 'acme/app5', pin_until: '2027-01-22T00:00:00Z', pin_tier: 'featured', pin_order: 4 });
  assert.ok(res.manifest.items.some((i) => i.id === 'acme/app1'), '过期置顶条目仍在 items');
  assert.deepEqual(validateLaunchpad(res.manifest), []);
});

test('同 id 续期：坑位满也允许，刷新到期时间并保留原顺位', () => {
  const items = [1, 2, 3, 4].map(itemN);
  const pinned = [1, 2, 3, 4].map((n) => pin(`acme/app${n}`, '2027-01-20T00:00:00Z', n));
  const res = applyLaunch(base(items, pinned), itemN(2), { label: 'pinned-30d', nowMs: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(res.pin.pin_order, 2);
  assert.equal(res.pin.pin_until, '2027-02-14T00:00:00Z');
  assert.equal(res.manifest.pinned.length, 4);
});

test('同 id 二次上架幂等：刷新版本与自荐语，保留首发时间、讨论绑定与互动计数，不造重复行', () => {
  const original = makeItem({ launched_at: '2027-01-01T00:00:00Z', discussion_upvotes: 50, discussion_comments_count: 7, stars_7d_delta: 12 });
  const update = makeItem({ latest_version: 'v0.5.0', maker_note: '新版自荐', launched_at: '2027-01-15T00:00:00Z' });
  delete update.discussion_number;
  delete update.discussion_url;
  delete update.discussion_repo;
  const res = applyLaunch(base([original]), update, { label: 'approved', nowMs: NOW });
  assert.equal(res.manifest.items.length, 1);
  const it = res.manifest.items[0];
  assert.equal(it.latest_version, 'v0.5.0');
  assert.equal(it.maker_note, '新版自荐');
  assert.equal(it.launched_at, '2027-01-01T00:00:00Z');
  assert.equal(it.discussion_number, 1);
  assert.equal(it.discussion_upvotes, 50);
  assert.equal(it.stars_7d_delta, 12);
});

test('dropExpiredPins 撤下到期项并重排顺位', () => {
  const out = dropExpiredPins(
    [pin('a/x', '2027-01-15T00:00:00Z', 1), pin('a/y', '2027-01-20T00:00:00Z', 3), pin('a/z', '2027-01-30T00:00:00Z', 2)],
    NOW,
  );
  assert.deepEqual(out.map((p) => [p.id, p.pin_order]), [['a/z', 1], ['a/y', 2]]);
});

test('讨论标题与传播物料包包含深链与徽章', () => {
  const item = makeItem();
  assert.ok(discussionTitle(item).startsWith('HyperTerm (acme/hyper-term) — '));
  const kit = renderShareKit(item, null);
  assert.ok(kit.includes('zstore://launchpad/acme/hyper-term'));
  assert.ok(kit.includes('zstore://app/acme/hyper-term'));
  assert.ok(kit.includes(item.discussion_url));
  assert.ok(kit.includes('img.shields.io'));
});
