import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchQuery,
  computeDelta,
  fetchGithubStats,
  refreshManifest,
  updateStarsHistory,
} from './refresh-pulse-and-pins.mjs';
import { validateLaunchpad } from './validate-launchpad.mjs';
import { makeItem } from './validate-launchpad.test.mjs';

const NOW = Date.parse('2027-01-15T00:15:00Z');

function base(items, pinned = []) {
  return { version: 1, generated_at: '2027-01-01T00:00:00Z', discussions_repo: 'superMC5657/z-store-launchpad', pinned, items };
}

test('到期置顶被撤下，条目本体与讨论编号完整保留', () => {
  const item = makeItem({ discussion_number: 9, discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/9' });
  const manifest = base([item], [{ id: item.id, pin_until: '2027-01-14T00:00:00Z', pin_tier: 'sponsor', pin_order: 1 }]);
  const res = refreshManifest(manifest, { version: 1, days: {} }, {}, NOW);
  assert.equal(res.manifest.pinned.length, 0);
  assert.equal(res.manifest.items.length, 1);
  assert.equal(res.manifest.items[0].discussion_number, 9);
  assert.equal(res.manifestChanged, true);
  assert.deepEqual(validateLaunchpad(res.manifest), []);
});

test('无实质变化时清单不变、不重写 generated_at', () => {
  const item = makeItem({ stars: 420, stars_7d_delta: 0 });
  const history = { version: 1, days: { '2027-01-14': { [item.id]: 420 } } };
  const res = refreshManifest(base([item]), history, { [item.id]: { stars: 420, forks: item.forks } }, NOW);
  assert.equal(res.manifestChanged, false);
  assert.equal(res.changed, false);
  assert.equal(res.manifest.generated_at, '2027-01-01T00:00:00Z');
});

test('历史快照只在变化时写入，并跨天滚动裁剪 14 天（保留 ≥7 天的基线锚点）', () => {
  const history = {
    version: 1,
    days: {
      '2026-12-20': { 'a/x': 10 },
      '2026-12-28': { 'a/x': 20 },
      '2027-01-05': { 'a/x': 30 },
      '2027-01-12': { 'a/x': 40 },
    },
  };
  const same = updateStarsHistory(history, { 'a/x': 40 }, '2027-01-15');
  assert.ok(!('2027-01-15' in same.days), '未变化不写今日快照');
  assert.deepEqual(Object.keys(same.days), ['2027-01-05', '2027-01-12']);

  const next = updateStarsHistory(history, { 'a/x': 55 }, '2027-01-15');
  assert.deepEqual(Object.keys(next.days), ['2027-01-05', '2027-01-12', '2027-01-15']);

  const sparse = updateStarsHistory({ version: 1, days: { '2026-12-01': { 'a/x': 5 } } }, { 'a/x': 9 }, '2027-01-15');
  assert.deepEqual(Object.keys(sparse.days), ['2026-12-01', '2027-01-15'], '窗口外最近基线保留为锚点');
});

test('stars_7d_delta：取 7 天前快照，不足 7 天取最早快照，负数归零', () => {
  const history = {
    version: 1,
    days: { '2027-01-05': { 'a/x': 100 }, '2027-01-09': { 'a/x': 130 }, '2027-01-12': { 'b/y': 7 } },
  };
  assert.equal(computeDelta(history, 'a/x', 160, '2027-01-15'), 60);
  assert.equal(computeDelta(history, 'b/y', 12, '2027-01-15'), 5);
  assert.equal(computeDelta(history, 'a/x', 50, '2027-01-15'), 0);
  assert.equal(computeDelta(history, 'c/z', 50, '2027-01-15'), 0);
});

test('刷新统计并计算涨星写回条目', () => {
  const item = makeItem({ stars: 400, stars_7d_delta: 0, discussion_upvotes: 1 });
  const history = { version: 1, days: { '2027-01-07': { [item.id]: 380 } } };
  const res = refreshManifest(
    base([item]),
    history,
    { [item.id]: { stars: 450, forks: 12, latest_version: 'v0.5.0', discussion_upvotes: 8, discussion_comments_count: 4 } },
    NOW,
  );
  const it = res.manifest.items[0];
  assert.equal(it.stars, 450);
  assert.equal(it.stars_7d_delta, 70);
  assert.equal(it.latest_version, 'v0.5.0');
  assert.equal(it.discussion_upvotes, 8);
  assert.equal(res.history.days['2027-01-15'][item.id], 450);
});

test('批量 GraphQL 只用变量绑定并按 25 个一批分组', async () => {
  const items = Array.from({ length: 27 }, (_, i) =>
    makeItem({ id: `o/r${i}`, owner: 'o', repo: `r${i}`, discussion_number: i + 1 }),
  );
  const { query, variables } = buildBatchQuery(items.slice(0, 2));
  assert.ok(!query.includes('"o"') && !query.includes('r0"'), '查询体不含用户输入');
  assert.equal(variables.o0, 'o');
  assert.equal(variables.r1, 'r1');
  assert.equal(variables.d1n, 2);

  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { variables: v } = JSON.parse(init.body);
    calls.push(v);
    const data = {};
    for (const key of Object.keys(v).filter((k) => /^r\d+$/.test(k))) {
      const i = key.slice(1);
      data[`r${i}`] = { stargazerCount: 1, forkCount: 0, latestRelease: { tagName: 'v1' } };
      data[`d${i}`] = { discussion: { upvoteCount: 2, comments: { totalCount: 3 } } };
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const stats = await fetchGithubStats(items, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(stats).length, 27);
  assert.deepEqual(stats['o/r26'], { stars: 1, forks: 0, latest_version: 'v1', discussion_comments_count: 3, discussion_upvotes: 2 });
});
