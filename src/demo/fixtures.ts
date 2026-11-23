import type {
  AppDetail,
  AppSummary,
  InstalledApp,
  UpdateItem,
  UpdateRule,
} from '../types';
import catalogRaw from '../../catalog.json';
import { DEFAULT_ICON_BG } from '../styles/tokens';
import { resolveAlternatives } from './alternatives';
import { DEMO_TREND_SNAPSHOT, type DemoTrendRow } from './trendSnapshot';

interface CatalogRaw {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  description_en?: string;
  category: string;
  category_name?: string;
  aliases?: string[];
  alternatives?: string[];
  default_version?: string;
  license?: string;
  stars?: number;
  forks?: number;
  is_verified?: boolean;
  homepage?: string | null;
  platforms?: string[];
  added_at?: string;
}

const catalogEntries = catalogRaw as unknown as CatalogRaw[];

function toSummary(c: CatalogRaw): AppSummary {
  const alternatives = resolveAlternatives(c.alternatives, c.id);
  return {
    id: c.id,
    name: c.name,
    description_en: c.description_en ?? c.description,
    owner: c.owner,
    repo: c.repo,
    icon: c.icon,
    icon_bg: c.icon_bg,
    description: c.description,
    stars: c.stars ?? 0,
    forks: c.forks ?? 0,
    license: c.license ?? 'MIT',
    latest_version: c.default_version ?? '1.0.0',
    category: c.category,
    category_name: c.category_name ?? c.category,
    is_verified: c.is_verified ?? false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: c.homepage ?? null,
    platforms: c.platforms && c.platforms.length > 0 ? c.platforms : [],
    added_at: c.added_at,
    ...(alternatives.length > 0 ? { alternatives } : {}),
  };
}

export const summaries: AppSummary[] = catalogEntries.map(toSummary);

/** 小写 id → 目录别名（人工策展的关键词），供演示站相似推荐使用。 */
export const catalogAliases: ReadonlyMap<string, readonly string[]> = new Map(
  catalogEntries.map((c) => [c.id.toLowerCase(), c.aliases ?? []]),
);

const summaryById = new Map<string, AppSummary>();
for (const s of summaries) {
  const key = s.id.toLowerCase();
  if (!summaryById.has(key)) summaryById.set(key, s);
}

export function findSummary(id: string): AppSummary | undefined {
  const clean = id.trim().toLowerCase();
  return (
    summaryById.get(clean) ??
    summaries.find((s) => `${s.owner}/${s.repo}`.toLowerCase() === clean) ??
    summaries.find((s) => `github.com/${s.owner}/${s.repo}`.toLowerCase() === clean)
  );
}

export function toDetail(s: AppSummary): AppDetail {
  const version = s.latest_version;
  const tag = version.startsWith('v') ? version : `v${version}`;
  const releaseBase = `https://${s.forge_host || 'github.com'}/${s.owner}/${s.repo}/releases/download/${tag}`;
  return {
    id: s.id,
    name: s.name,
    description_en: s.description_en,
    owner: s.owner,
    repo: s.repo,
    icon: s.icon,
    icon_bg: s.icon_bg,
    description: s.description,
    stars: s.stars,
    forks: s.forks,
    license: s.license,
    latest_version: version,
    changelog: `## ${version} (demo)\n\nBundled demo metadata — connect the desktop app for live changelogs.`,
    is_verified: s.is_verified,
    readme_markdown: `# ${s.name}\n\n${s.description}\n\n> Live-demo bundle: full README unavailable offline.`,
    releases: [
      {
        name: `${s.repo}-${version}-windows-x64.msi`,
        download_url: `${releaseBase}/${s.repo}-${version}-windows-x64.msi`,
        size_bytes: 32 * 1024 * 1024,
        sha256: 'demo',
        os: 'windows',
        arch: 'x86_64',
        kind: 'msi',
      },
      {
        name: `${s.repo}-${version}-macos-universal.dmg`,
        download_url: `${releaseBase}/${s.repo}-${version}-macos-universal.dmg`,
        size_bytes: 28 * 1024 * 1024,
        sha256: 'demo',
        os: 'macos',
        arch: 'universal',
        kind: 'dmg',
      },
      {
        name: `${s.repo}-${version}-linux-x86_64.AppImage`,
        download_url: `${releaseBase}/${s.repo}-${version}-linux-x86_64.AppImage`,
        size_bytes: 36 * 1024 * 1024,
        sha256: 'demo',
        os: 'linux',
        arch: 'x86_64',
        kind: 'appimage',
      },
    ],
    category: s.category,
    category_name: s.category_name,
    forge: s.forge,
    forge_host: s.forge_host,
    homepage: s.homepage,
    platforms: s.platforms,
    ...(s.alternatives && s.alternatives.length > 0 ? { alternatives: s.alternatives } : {}),
  };
}

export function summaryToInstalled(s: AppSummary): InstalledApp {
  return {
    app_id: s.id,
    app_name: s.name,
    version: s.latest_version,
    installed_at: Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
    install_method: 'demo',
    install_path: `C:\\Program Files\\${s.name}`,
    asset_name: `${s.repo}-${s.latest_version}-windows-x64.msi`,
    asset_sha256: 'demo',
    icon: s.icon,
    icon_bg: s.icon_bg,
  };
}

/** 与后端 `should_include_update` 同口径：锁定不提示；跳过的版本恰为最新版不提示；隐藏照常产出。 */
function shouldIncludeUpdate(current: string, latest: string, rule: UpdateRule | undefined): boolean {
  if (rule?.is_frozen) return false;
  const bare = (v: string): string => v.replace(/^v+/, '').trim();
  if (rule?.skipped_version != null && bare(rule.skipped_version) === bare(latest)) return false;
  return current !== latest;
}

/** 演示更新：已装版本落后于目录版本、且未被更新规则拦下的应用产出更新项（只覆盖已安装应用）。 */
export function buildDemoUpdates(installed: InstalledApp[], rules: readonly UpdateRule[]): UpdateItem[] {
  const ruleById = new Map(rules.map((r) => [r.app_id.toLowerCase(), r]));
  const out: UpdateItem[] = [];
  for (const item of installed) {
    const summary = summaries.find((s) => s.id.toLowerCase() === item.app_id.toLowerCase());
    if (!summary) continue;
    if (!shouldIncludeUpdate(item.version, summary.latest_version, ruleById.get(summary.id.toLowerCase()))) continue;
    out.push({
      app_id: item.app_id,
      app_name: summary.name,
      current_version: item.version,
      latest_version: summary.latest_version,
      changelog: `### ${summary.latest_version}
- Bug fixes and performance improvements.
- Updated dependencies and refreshed translations.
- See the project release page for the full changelog.`,
      icon: summary.icon,
      icon_bg: summary.icon_bg,
    });
  }
  return out;
}

/** 趋势榜快照（trendSnapshot.ts）三个周期去重后的全部仓库（同一仓库多榜同上时取日榜那份）。 */
const DEMO_EXTERNAL_TRENDS: ReadonlyMap<string, DemoTrendRow> = (() => {
  const byId = new Map<string, DemoTrendRow>();
  for (const since of ['daily', 'weekly', 'monthly'] as const) {
    for (const t of DEMO_TREND_SNAPSHOT[since]) {
      const id = `${t.owner}/${t.repo}`.toLowerCase();
      if (!byId.has(id)) byId.set(id, t);
    }
  }
  return byId;
})();

function escapeTrendHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function demoTrendPathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9_.-]+/g, '-') || 'repo';
}

const DEMO_TREND_SINCE_SUFFIX = { daily: 'today', weekly: 'this week', monthly: 'this month' } as const;

type DemoTrendSince = keyof typeof DEMO_TREND_SINCE_SUFFIX;

function demoTrendingSince(url: string): DemoTrendSince {
  const token = /[?&]since=(daily|weekly|monthly)/i.exec(url)?.[1]?.toLowerCase();
  return token === 'weekly' || token === 'monthly' ? token : 'daily';
}

/** 非目录趋势仓库的卡片：分类统一记为「开发编程」（与 catalog.json 的 `dev` 同名）。 */
export function demoExternalFallback(t: DemoTrendRow): AppSummary {
  return {
    id: `${t.owner}/${t.repo}`.toLowerCase(),
    name: t.repo,
    description_en: t.desc,
    owner: t.owner,
    repo: t.repo,
    icon: t.icon,
    icon_bg: DEFAULT_ICON_BG,
    description: t.desc,
    stars: t.stars,
    forks: t.forks,
    license: 'MIT',
    latest_version: 'latest',
    category: 'dev',
    category_name: '开发编程',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [...t.platforms],
  };
}

export function findExternalTrend(owner: string, repo: string): DemoTrendRow | undefined {
  return DEMO_EXTERNAL_TRENDS.get(`${owner}/${repo}`.toLowerCase());
}

function buildDemoTrendingHtml(url: string): string {
  const since = demoTrendingSince(url);
  const gainSuffix = DEMO_TREND_SINCE_SUFFIX[since];
  const top = DEMO_TREND_SNAPSHOT[since];
  const articles = top.map((t) => {
    const path = `${demoTrendPathSegment(t.owner)}/${demoTrendPathSegment(t.repo)}`;
    const desc = escapeTrendHtml(t.desc);
    const name = escapeTrendHtml(t.repo);
    return [
      '<article class="Box-row">',
      `<h2 class="h3 lh-condensed"><a href="/${path}">${name}</a></h2>`,
      `<p class="col-9 color-fg-muted my-1 pr-4">${desc}</p>`,
      '<div class="f6 color-fg-muted mt-2">',
      `<a class="muted-link d-inline-block mr-3" href="/${path}/stargazers">${t.stars}</a>`,
      `<a class="muted-link d-inline-block mr-3" href="/${path}/forks">${t.forks}</a>`,
      `<span class="d-inline-block float-sm-right">${t.gain} stars ${gainSuffix}</span>`,
      '</div>',
      '</article>',
    ].join('\n');
  });
  return `<div class="Box">\n${articles.join('\n')}\n</div>`;
}

function buildDemoDoforceJson(): string {
  const items = DEMO_TREND_SNAPSHOT.daily.map((t) => ({
    repo: `/${t.owner}/${t.repo}`,
    desc: t.desc,
    lang: t.lang,
    stars: t.stars,
    forks: t.forks,
    change: t.gain,
  }));
  return JSON.stringify(items);
}

/** 搜索兜底源取周榜，与 doforce（日榜）区分开。 */
function buildDemoGitHubSearchJson(): string {
  const items = DEMO_TREND_SNAPSHOT.weekly.map((t) => ({
    full_name: `${t.owner}/${t.repo}`,
    stargazers_count: t.stars,
    forks_count: t.forks,
    description: t.desc,
    html_url: `https://github.com/${t.owner}/${t.repo}`,
  }));
  return JSON.stringify({ items });
}

export function demoTrendsTextForUrl(url: string): string {
  if (url.includes('github.com/trending')) return buildDemoTrendingHtml(url);
  if (url.includes('trend.doforce.dpdns.org')) return buildDemoDoforceJson();
  if (url.includes('api.github.com/search')) return buildDemoGitHubSearchJson();
  return '';
}
