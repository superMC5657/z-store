import type { LaunchpadEntry, LaunchpadSortMode } from '../../types';

const DAY_MS = 86_400_000;

function launchedMs(entry: LaunchpadEntry): number {
  const t = Date.parse(entry.launched_at);
  return Number.isFinite(t) ? t : 0;
}

function idOf(entry: LaunchpadEntry): string {
  return entry.summary.id.toLowerCase();
}

/** 按首发时间衰减的推荐热度分（结合社区互动、7 日涨星与总星数）。 */
export function launchpadHotScore(entry: LaunchpadEntry, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - launchedMs(entry)) / DAY_MS);
  const numerator =
    10 +
    3 * Math.log1p(Math.max(0, entry.discussion_upvotes)) +
    2.5 * Math.log1p(Math.max(0, entry.discussion_comments_count)) +
    2 * Math.log1p(Math.max(0, entry.stars_7d_delta)) +
    0.5 * Math.log1p(Math.max(0, entry.summary.stars));
  return numerator / Math.pow(1 + ageDays / 7, 1.2);
}

function discussionHeat(entry: LaunchpadEntry): number {
  return entry.discussion_comments_count * 2 + entry.discussion_upvotes;
}

/** 三档确定性排序（不改变集合大小）。 */
export function sortLaunchpadItems(
  items: readonly LaunchpadEntry[],
  mode: LaunchpadSortMode,
  nowMs: number = Date.now(),
): LaunchpadEntry[] {
  const byLaunchThenId = (a: LaunchpadEntry, b: LaunchpadEntry): number =>
    launchedMs(b) - launchedMs(a) || idOf(a).localeCompare(idOf(b));
  const out = [...items];
  switch (mode) {
    case 'latest':
      return out.sort(
        (a, b) =>
          launchedMs(b) - launchedMs(a) ||
          b.summary.stars - a.summary.stars ||
          idOf(a).localeCompare(idOf(b)),
      );
    case 'discussions':
      return out.sort((a, b) => discussionHeat(b) - discussionHeat(a) || byLaunchThenId(a, b));
    case 'recommended':
    default: {
      const scores = new Map(out.map((e) => [e, launchpadHotScore(e, nowMs)]));
      return out.sort((a, b) => (scores.get(b)! - scores.get(a)!) || byLaunchThenId(a, b));
    }
  }
}
