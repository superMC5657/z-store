import type {
  AppDetail,
  AppSummary,
  InstalledApp,
  MirrorNodeStatus,
  UpdateItem,
} from '../types';
import catalogRaw from '../../catalog.json';

export interface CatalogRaw {
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
  default_version?: string;
  license?: string;
  stars?: number;
  forks?: number;
  is_verified?: boolean;
  homepage?: string | null;
  platforms?: string[];
}

export const catalogEntries = catalogRaw as unknown as CatalogRaw[];

export function toSummary(c: CatalogRaw): AppSummary {
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
  };
}

export const summaries: AppSummary[] = catalogEntries.map(toSummary);

export const summaryById = new Map<string, AppSummary>();
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
        download_url: `https://github.com/${s.id}/releases/download/${tag}/${s.repo}-${version}-windows-x64.msi`,
        size_bytes: 32 * 1024 * 1024,
        sha256: 'demo',
        os: 'windows',
        arch: 'x86_64',
        kind: 'msi',
      },
      {
        name: `${s.repo}-${version}-macos-universal.dmg`,
        download_url: `https://github.com/${s.id}/releases/download/${tag}/${s.repo}-${version}-macos-universal.dmg`,
        size_bytes: 28 * 1024 * 1024,
        sha256: 'demo',
        os: 'macos',
        arch: 'universal',
        kind: 'dmg',
      },
      {
        name: `${s.repo}-${version}-linux-x86_64.AppImage`,
        download_url: `https://github.com/${s.id}/releases/download/${tag}/${s.repo}-${version}-linux-x86_64.AppImage`,
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
  };
}

export function summaryToInstalled(s: AppSummary, version?: string): InstalledApp {
  return {
    app_id: s.id,
    app_name: s.name,
    version: version ?? s.latest_version,
    installed_at: Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
    install_method: 'demo',
    install_path: `C:\\Program Files\\${s.name}`,
    asset_name: `${s.repo}-${s.latest_version}-windows-x64.msi`,
    asset_sha256: 'demo',
    icon: s.icon,
    icon_bg: s.icon_bg,
  };
}

export const demoMirrors: MirrorNodeStatus[] = [
  {
    id: 'ghproxy',
    name: 'GHProxy (demo)',
    base_url: 'https://ghproxy.demo/',
    latency_ms: 120,
    is_active: true,
  },
  {
    id: 'direct',
    name: 'Direct (demo)',
    base_url: 'https://github.com/',
    latency_ms: 320,
    is_active: false,
  },
];

export function buildDemoUpdates(installed: InstalledApp[]): UpdateItem[] {
  const target = summaries[2] ?? summaries[0];
  if (!target) return [];
  const current = installed.find((i) => i.app_id.toLowerCase() === target.id.toLowerCase());
  return [
    {
      app_id: target.id,
      app_name: target.name,
      current_version: current?.version ?? '1.0.0-demo',
      latest_version: target.latest_version,
      changelog: `Demo update for ${target.name} — desktop app applies it for real.`,
      icon: target.icon,
      icon_bg: target.icon_bg,
    },
  ];
}

export interface DemoExternalTrend {
  owner: string;
  repo: string;
  desc: string;
  lang: string;
  stars: number;
  forks: number;
  change: number;
  gain: number;
  cat: string;
  catn: string;
}

export const DEMO_EXTERNAL_TRENDS: readonly DemoExternalTrend[] = [
  { owner: 'facebook', repo: 'react', desc: 'The library for web and native user interfaces.', lang: 'JavaScript', stars: 229000, forks: 48200, change: 2400, gain: 277, cat: 'dev', catn: '开发工具' },
  { owner: 'vuejs', repo: 'vue', desc: 'A progressive, incrementally-adoptable JavaScript framework.', lang: 'JavaScript', stars: 207000, forks: 34800, change: 2342, gain: 890, cat: 'dev', catn: '开发工具' },
  { owner: 'tensorflow', repo: 'tensorflow', desc: 'An open source machine learning framework for everyone.', lang: 'C++', stars: 187000, forks: 75000, change: 2243, gain: 1503, cat: 'ai', catn: 'AI 工具' },
  { owner: 'Significant-Gravitas', repo: 'AutoGPT', desc: 'An experimental open-source attempt to make GPT-4 fully autonomous.', lang: 'Python', stars: 178000, forks: 47000, change: 2144, gain: 616, cat: 'ai', catn: 'AI 工具' },
  { owner: 'microsoft', repo: 'vscode', desc: 'Visual Studio Code.', lang: 'TypeScript', stars: 177000, forks: 31000, change: 2045, gain: 1229, cat: 'dev', catn: '开发工具' },
  { owner: 'ollama', repo: 'ollama', desc: 'Get up and running with large language models.', lang: 'Go', stars: 135000, forks: 11000, change: 1946, gain: 342, cat: 'ai', catn: 'AI 工具' },
  { owner: 'vercel', repo: 'next.js', desc: 'The React Framework for the Web.', lang: 'TypeScript', stars: 129000, forks: 29600, change: 1847, gain: 955, cat: 'dev', catn: '开发工具' },
  { owner: 'golang', repo: 'go', desc: 'The Go programming language.', lang: 'Go', stars: 129000, forks: 18000, change: 1748, gain: 1568, cat: 'dev', catn: '开发工具' },
  { owner: 'n8n-io', repo: 'n8n', desc: 'Fair-code workflow automation for technical teams.', lang: 'TypeScript', stars: 118000, forks: 32000, change: 1649, gain: 681, cat: 'dev', catn: '开发工具' },
  { owner: 'kubernetes', repo: 'kubernetes', desc: 'Production-grade container scheduling and management.', lang: 'Go', stars: 116000, forks: 43000, change: 1550, gain: 1294, cat: 'dev', catn: '开发工具' },
  { owner: 'microsoft', repo: 'TypeScript', desc: 'TypeScript is a superset of JavaScript that compiles to clean JavaScript output.', lang: 'TypeScript', stars: 105000, forks: 13300, change: 1451, gain: 407, cat: 'dev', catn: '开发工具' },
  { owner: 'langchain-ai', repo: 'langchain', desc: 'Build context-aware reasoning applications with LLMs.', lang: 'Python', stars: 105000, forks: 17000, change: 1393, gain: 1020, cat: 'ai', catn: 'AI 工具' },
  { owner: 'rust-lang', repo: 'rust', desc: 'Empowering everyone to build reliable and efficient software.', lang: 'Rust', stars: 102000, forks: 13400, change: 1294, gain: 1633, cat: 'dev', catn: '开发工具' },
  { owner: 'excalidraw', repo: 'excalidraw', desc: 'Virtual whiteboard for sketching hand-drawn like diagrams.', lang: 'TypeScript', stars: 100000, forks: 11000, change: 1195, gain: 746, cat: 'dev', catn: '开发工具' },
  { owner: 'shadcn-ui', repo: 'ui', desc: 'Beautifully designed copy-paste React components.', lang: 'TypeScript', stars: 95000, forks: 7000, change: 1096, gain: 1359, cat: 'dev', catn: '开发工具' },
  { owner: 'oven-sh', repo: 'bun', desc: 'Incredibly fast JavaScript runtime, bundler, test runner, and package manager.', lang: 'Zig', stars: 92000, forks: 4000, change: 997, gain: 472, cat: 'dev', catn: '开发工具' },
  { owner: 'tauri-apps', repo: 'tauri', desc: 'Build smaller, faster, and more secure desktop and mobile applications.', lang: 'Rust', stars: 91000, forks: 3000, change: 898, gain: 1085, cat: 'dev', catn: '开发工具' },
  { owner: 'pytorch', repo: 'pytorch', desc: 'Tensors and dynamic neural networks in Python with strong GPU acceleration.', lang: 'C++', stars: 90000, forks: 25000, change: 799, gain: 198, cat: 'ai', catn: 'AI 工具' },
  { owner: 'sveltejs', repo: 'svelte', desc: 'Cybernetically enhanced web apps.', lang: 'JavaScript', stars: 84000, forks: 4300, change: 700, gain: 811, cat: 'dev', catn: '开发工具' },
  { owner: 'comfyanonymous', repo: 'ComfyUI', desc: 'A powerful and modular diffusion-model GUI with a graph interface.', lang: 'Python', stars: 83000, forks: 9000, change: 601, gain: 1424, cat: 'ai', catn: 'AI 工具' },
  { owner: 'ggerganov', repo: 'llama.cpp', desc: 'LLM inference in C/C++.', lang: 'C++', stars: 82000, forks: 12000, change: 502, gain: 537, cat: 'ai', catn: 'AI 工具' },
  { owner: 'openai', repo: 'whisper', desc: 'Robust speech recognition via large-scale weak supervision.', lang: 'Python', stars: 78000, forks: 20000, change: 444, gain: 1150, cat: 'ai', catn: 'AI 工具' },
  { owner: 'immich-app', repo: 'immich', desc: 'High performance self-hosted photo and video management solution.', lang: 'TypeScript', stars: 70000, forks: 4000, change: 345, gain: 263, cat: 'dev', catn: '开发工具' },
  { owner: 'astral-sh', repo: 'uv', desc: 'An extremely fast Python package and project manager, written in Rust.', lang: 'Rust', stars: 55000, forks: 3000, change: 246, gain: 876, cat: 'dev', catn: '开发工具' },
];

export function escapeTrendHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function demoTrendPathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9_.-]+/g, '-') || 'repo';
}

export const DEMO_TREND_SINCE_SUFFIX = { daily: 'today', weekly: 'this week', monthly: 'this month' } as const;

export type DemoTrendSince = keyof typeof DEMO_TREND_SINCE_SUFFIX;

export function demoTrendingSince(url: string): DemoTrendSince {
  const token = /[?&]since=(daily|weekly|monthly)/i.exec(url)?.[1]?.toLowerCase();
  return token === 'weekly' || token === 'monthly' ? token : 'daily';
}

export function demoFallbackGradient(cat: string): string {
  if (cat === 'ai') return 'linear-gradient(135deg, #7c3aed, #4c1d95)';
  return 'linear-gradient(135deg, #475569, #334155)';
}

export function demoExternalFallback(t: DemoExternalTrend): AppSummary {
  return {
    id: `${t.owner}/${t.repo}`.toLowerCase(),
    name: t.repo,
    description_en: t.desc,
    owner: t.owner,
    repo: t.repo,
    icon: '',
    icon_bg: demoFallbackGradient(t.cat),
    description: t.desc,
    stars: t.stars,
    forks: t.forks,
    license: 'MIT',
    latest_version: 'latest',
    category: t.cat,
    category_name: t.catn,
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  };
}

export function findExternalTrend(owner: string, repo: string): DemoExternalTrend | undefined {
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  return DEMO_EXTERNAL_TRENDS.find((t) => t.owner.toLowerCase() === o && t.repo.toLowerCase() === r);
}

export function buildDemoTrendingHtml(url: string): string {
  const gainSuffix = DEMO_TREND_SINCE_SUFFIX[demoTrendingSince(url)];
  const top = DEMO_EXTERNAL_TRENDS.slice(0, 20);
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

export function buildDemoDoforceJson(): string {
  const items = DEMO_EXTERNAL_TRENDS.slice(2, 22).map((t) => ({
    repo: `/${t.owner}/${t.repo}`,
    desc: t.desc,
    lang: t.lang,
    stars: t.stars,
    forks: t.forks,
    change: t.change,
  }));
  return JSON.stringify(items);
}

export function buildDemoGitHubSearchJson(): string {
  const items = DEMO_EXTERNAL_TRENDS.slice(4, 24).map((t) => ({
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
