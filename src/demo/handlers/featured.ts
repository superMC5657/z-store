import type { AppSummary, FeaturedPage, FeaturedPick, FeaturedShelf, ProfileState } from '../../types';
import { demoStore, visibleCatalogSummaries } from '../demoState';
import { argNum, argStr, warnUnknownArgs, type InvokeArgs } from './common';

// 负反馈与兴趣种子为 `DemoStore.featured` 会话态：刷新页面即重置。
function featured() {
  return demoStore().featured;
}

/** 分类未被「少推这类」。 */
function isLiveCategory(category: string): boolean {
  return !featured().dismissedCategories.has(category.toLowerCase());
}

/** 演示站可经 `?featured=cold|off|warm` 切换画像状态，缺省 `rich`。 */
function demoProfileState(): ProfileState {
  try {
    const v = new URLSearchParams(window.location.search).get('featured');
    if (v === 'cold' || v === 'off' || v === 'warm' || v === 'rich') {
      return v === 'cold' && featured().interestSeeds.length > 0 ? 'warm' : v;
    }
  } catch {
    // 非浏览器环境回退默认
  }
  return 'rich';
}

function argIds(a: InvokeArgs, key: string): Set<string> | null {
  const raw = a[key];
  if (!Array.isArray(raw)) return null;
  return new Set(raw.map((x) => String(x).toLowerCase()));
}

export function handleGetFeaturedPage(a: InvokeArgs): FeaturedPage {
  warnUnknownArgs(['visitSeed', 'allowedIds'], a, 'handleGetFeaturedPage');
  const seed = Math.floor(argNum(a, 'visitSeed') ?? 0);
  const allowed = argIds(a, 'allowedIds');
  const state = demoProfileState();
  const personalized = state === 'warm' || state === 'rich';

  const { dismissedApps, interestSeeds } = featured();
  const pool = visibleCatalogSummaries()
    .filter((s) => (!allowed || allowed.has(s.id.toLowerCase())) && !dismissedApps.has(s.id.toLowerCase()))
    .slice()
    .sort((x, y) => y.stars - x.stars || x.id.localeCompare(y.id));
  // 访问种子轮换：按种子把池子转一个偏移，同一次访问内稳定。
  const offset = pool.length > 0 ? seed % Math.min(pool.length, 7) : 0;
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];

  const used = new Set<string>();
  const take = (rows: AppSummary[], n: number) => {
    const out: AppSummary[] = [];
    for (const r of rows) {
      if (out.length >= n) break;
      const k = r.id.toLowerCase();
      if (used.has(k)) continue;
      used.add(k);
      out.push(r);
    }
    return out;
  };

  const heroCats = new Set<string>();
  const hero: FeaturedPick[] = [];
  // 与后端一致：先在未被「少推这类」的分类里互斥取满，凑不满才用被少推的分类补位。
  for (const allowDismissed of [false, true]) {
    for (const s of rotated) {
      if (hero.length >= 3) break;
      if (heroCats.has(s.category)) continue;
      if (!allowDismissed && !isLiveCategory(s.category)) continue;
      heroCats.add(s.category);
      used.add(s.id.toLowerCase());
      hero.push({ app: s, reasons: personalized ? [{ kind: 'category', category: s.category }] : [] });
    }
  }

  const shelves: FeaturedShelf[] = [];
  const byCat = (cat: string) => rotated.filter((s) => s.category === cat);
  const cats = Array.from(new Set(rotated.map((s) => s.category)));
  const liveCats = cats.filter(isLiveCategory);

  if (personalized) {
    const seedApp = rotated.find(
      (s) => !used.has(s.id.toLowerCase()) && isLiveCategory(s.category),
    );
    if (seedApp) {
      used.add(seedApp.id.toLowerCase());
      const items = take(byCat(seedApp.category), 4);
      if (items.length >= 3) {
        shelves.push({
          kind: 'because_you',
          seed_id: seedApp.id,
          seed_relation: 'favorite',
          items: items.map((app) => ({ app, reasons: [{ kind: 'owner', owner: app.owner }] })),
        });
      }
    }
  } else {
    const fresh = take(
      rotated.filter((s) => s.added_at && isLiveCategory(s.category)),
      4,
    );
    if (fresh.length >= 3) {
      shelves.push({
        kind: 'fresh',
        items: fresh.map((app) => ({ app, reasons: [{ kind: 'fresh', added_at: app.added_at ?? '' }] })),
      });
    }
  }

  const pickCats = (personalized && interestSeeds.length > 0 ? interestSeeds : cats).filter(isLiveCategory);
  let picked = 0;
  for (const cat of pickCats) {
    if (picked >= (state === 'warm' ? 1 : 2)) break;
    const items = take(byCat(cat), 4);
    if (items.length < 3) continue;
    picked += 1;
    shelves.push({ kind: 'category_pick', category: cat, items: items.map((app) => ({ app, reasons: [] })) });
  }

  if (state === 'rich') {
    const explore: FeaturedPick[] = [];
    for (const cat of [...liveCats].reverse()) {
      if (explore.length >= 4) break;
      const [app] = take(byCat(cat), 1);
      if (app) explore.push({ app, reasons: [{ kind: 'explore', category: cat }] });
    }
    if (explore.length >= 3) shelves.push({ kind: 'explore', items: explore });
  }

  // 与后端一致：按组装顺序去重，输出按页面展示位次排列（spec §2）。
  const displayRank: Record<FeaturedShelf['kind'], number> = {
    because_you: 0,
    category_pick: 1,
    explore: 2,
    fresh: 3,
  };
  shelves.sort((a, b) => displayRank[a.kind] - displayRank[b.kind]);

  return {
    profile_state: state,
    signal_count: personalized ? 12 : 0,
    top_categories: personalized ? cats.slice(0, 3) : [],
    hero,
    shelves,
  };
}

export function handleSaveInterestSeeds(a: InvokeArgs): null {
  const raw = a['categories'];
  featured().interestSeeds = Array.isArray(raw) ? raw.map((x) => String(x)) : [];
  return null;
}

export function handleDismissFeatured(a: InvokeArgs): null {
  warnUnknownArgs(['target', 'scope', 'appId'], a, 'handleDismissFeatured');
  const target = argStr(a, 'target').toLowerCase();
  const scope = argStr(a, 'scope');
  const { dismissedApps, dismissedCategories } = featured();
  if (scope === 'app') dismissedApps.add(target);
  if (scope === 'category') {
    dismissedCategories.add(target);
    const appId = argStr(a, 'appId').toLowerCase();
    if (appId) dismissedApps.add(appId);
  }
  return null;
}

export function handleClearFeedFeedback(): number {
  const { dismissedApps, dismissedCategories } = featured();
  const n = dismissedApps.size + dismissedCategories.size;
  dismissedApps.clear();
  dismissedCategories.clear();
  return n;
}
