/**
 * Live-demo Tauri mock (`/live-demo` embed).
 *
 * Browser-only stand-in for the Tauri IPC layer. Installed BEFORE `App` mounts
 * (see `src/main.tsx` demo branch) so that `services/api.ts` evaluates
 * `isTauri === true` and all `tauriApi` calls flow through `invoke`.
 *
 * Scope: views-touched commands only (see `demoInvoke` switch). Everything else
 * falls back to shape-safe defaults (`[]` for list-returning commands, `null`
 * otherwise) with a warn-once, so unmocked surfaces fail soft instead of
 * crashing the embed.
 *
 * Fixtures are typed against `src/types` (+ `services/api` result types via
 * `import type`, erased at runtime to avoid pulling `api.ts` before install);
 * backend drift surfaces as `tsc` errors.
 *
 * Guard: auto-installs only when `import.meta.env.VITE_DEMO` is set, so the
 * normal Tauri build (which never sets it and only dynamically imports this
 * module inside a dead branch) excludes it from execution — and keeps the
 * 360-entry `catalog.json` out of the desktop bundle.
 */
import type {
  AppDetail,
  AppSettings,
  AppSummary,
  DeveloperProfile,
  DownloadAssetResult,
  DownloadProgressPayload,
  HostRateLimitStatus,
  HostTokenEntry,
  ImportUserDataCounts,
  InstalledApp,
  MirrorNodeStatus,
  ProxyTestResult,
  StarAppResult,
  StarredSyncResult,
  SyncCatalogResult,
  UpdateItem,
} from '../types';
import type { AppIconCycleResult, ReadmeVariantsResult } from '../services/api';
import catalogRaw from '../../catalog.json';

// ---------------------------------------------------------------------------
// Catalog fixtures (bundled catalog.json)
// ---------------------------------------------------------------------------

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
  default_version?: string;
  license?: string;
  stars?: number;
  forks?: number;
  is_verified?: boolean;
  homepage?: string | null;
  platforms?: string[];
}

const catalogEntries = catalogRaw as unknown as CatalogRaw[];

function toSummary(c: CatalogRaw): AppSummary {
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

const summaries: AppSummary[] = catalogEntries.map(toSummary);

const summaryById = new Map<string, AppSummary>();
for (const s of summaries) {
  const key = s.id.toLowerCase();
  if (!summaryById.has(key)) summaryById.set(key, s);
}

function findSummary(id: string): AppSummary | undefined {
  const clean = id.trim().toLowerCase();
  return (
    summaryById.get(clean) ??
    summaries.find((s) => `${s.owner}/${s.repo}`.toLowerCase() === clean) ??
    summaries.find((s) => `github.com/${s.owner}/${s.repo}`.toLowerCase() === clean)
  );
}

function toDetail(s: AppSummary): AppDetail {
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

// Static demo values (installed / mirrors / updates)
function summaryToInstalled(s: AppSummary, version?: string): InstalledApp {
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

const demoMirrors: MirrorNodeStatus[] = [
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

function buildDemoUpdates(installed: InstalledApp[]): UpdateItem[] {
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

// ---------------------------------------------------------------------------
// Demo display defaults (embed-only): UI scale 0.9 + 12px font.
// Desktop defaults (DEFAULT_SETTINGS in services/api.ts: ui_scale '100' /
// font_size '14') are NEVER touched — this lives entirely in the demo layer.
// URL override (read live at invoke/bootstrap time, highest precedence):
//   ?scale=0.9 | ?scale=90 | ?ui_scale=90   and   ?font=12 | ?font=12px | ?font_size=12
// ---------------------------------------------------------------------------

const DEMO_UI_SCALE: AppSettings['ui_scale'] = '90';
const DEMO_FONT_SIZE: AppSettings['font_size'] = '12';

// Greppable build marker: plain string literal (values baked in) so it
// survives minification verbatim — verify with grep for
// `zstore:demo:display-defaults` / `ui_scale=90` / `font_size=12`.
// Exposed on window in installDemoMock so tree-shaking keeps it.
// NOTE: keep in sync with DEMO_UI_SCALE / DEMO_FONT_SIZE above —
// installDemoMock throws if they ever drift apart.
const DEMO_DISPLAY_DEFAULTS_MARKER = 'zstore:demo:display-defaults:ui_scale=90:font_size=12';

const ALLOWED_UI_SCALES: ReadonlySet<string> = new Set(['90', '100', '110', '125']);
const ALLOWED_FONT_SIZES: ReadonlySet<string> = new Set([
  '12',
  '14',
  '16',
  '18',
  '20',
  'small',
  'standard',
  'medium',
  'large',
]);

function normalizeDemoUiScale(raw: string | null | undefined): AppSettings['ui_scale'] | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (ALLOWED_UI_SCALES.has(v)) return v as AppSettings['ui_scale'];
  if (v === '0.9' || v === '0.90') return '90';
  if (v === '1' || v === '1.0' || v === '1.00') return '100';
  if (v === '1.1' || v === '1.10') return '110';
  if (v === '1.25') return '125';
  return null;
}

function normalizeDemoFontSize(raw: string | null | undefined): AppSettings['font_size'] | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/px$/, '');
  if (ALLOWED_FONT_SIZES.has(v)) return v as AppSettings['font_size'];
  return null;
}

/** Effective demo display defaults: hardcoded 90/12 < saved sliders < URL params. */
export function resolveDemoDisplayDefaults(): {
  ui_scale: AppSettings['ui_scale'];
  font_size: AppSettings['font_size'];
} {
  let ui_scale: AppSettings['ui_scale'] = DEMO_UI_SCALE;
  let font_size: AppSettings['font_size'] = DEMO_FONT_SIZE;
  try {
    if (demoSettingsSaved['ui_scale'] && ALLOWED_UI_SCALES.has(demoSettingsSaved['ui_scale'])) {
      ui_scale = demoSettingsSaved['ui_scale'] as AppSettings['ui_scale'];
    }
    if (demoSettingsSaved['font_size'] && ALLOWED_FONT_SIZES.has(demoSettingsSaved['font_size'])) {
      font_size = demoSettingsSaved['font_size'] as AppSettings['font_size'];
    }
  } catch {
    // keep hardcoded defaults
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const urlScale = normalizeDemoUiScale(params.get('scale') ?? params.get('ui_scale') ?? params.get('uiScale'));
    if (urlScale) ui_scale = urlScale;
    const urlFont = normalizeDemoFontSize(params.get('font') ?? params.get('font_size') ?? params.get('fontSize'));
    if (urlFont) font_size = urlFont;
  } catch {
    // non-browser / malformed URL — keep defaults
  }
  return { ui_scale, font_size };
}

// ---------------------------------------------------------------------------
// localStorage-backed demo state (search/history, favorites/watch/star)
// ---------------------------------------------------------------------------

const LS = {
  favorites: 'zstore:demo:favorites:v1',
  watched: 'zstore:demo:watched:v1',
  starred: 'zstore:demo:starred:v1',
  searchHistory: 'zstore:demo:search_history:v1',
  recentViews: 'zstore:demo:recent_views:v1',
  installed: 'zstore:demo:installed:v1',
  settings: 'zstore:demo:settings:v1',
} as const;

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / quota — keep in-memory state
  }
}

function lsStringArray(key: string): string[] {
  const v = lsGet<unknown>(key, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// In-memory working state (hydrated from localStorage at install)
let favSet = new Set<string>();
let watchSet = new Set<string>();
let starSet = new Set<string>();
let searchHistory: string[] = [];
let recentIds: string[] = [];
let installedApps: InstalledApp[] = [];
let demoSettingsSaved: Record<string, string> = {};
const iconLevel = new Map<string, number>();

function persistSets(): void {
  lsSet(LS.favorites, [...favSet]);
  lsSet(LS.watched, [...watchSet]);
  lsSet(LS.starred, [...starSet]);
  lsSet(LS.searchHistory, searchHistory);
  lsSet(LS.recentViews, recentIds);
  lsSet(LS.installed, installedApps);
}

function hydrate(): void {
  favSet = new Set(lsStringArray(LS.favorites).map((s) => s.toLowerCase()));
  watchSet = new Set(lsStringArray(LS.watched).map((s) => s.toLowerCase()));
  starSet = new Set(lsStringArray(LS.starred).map((s) => s.toLowerCase()));
  searchHistory = lsStringArray(LS.searchHistory).slice(0, 20);
  recentIds = lsStringArray(LS.recentViews).slice(0, 20);
  const stored = lsGet<unknown>(LS.installed, null);
  if (Array.isArray(stored) && stored.length > 0) {
    const valid = (stored as InstalledApp[]).filter((i) => typeof i?.app_id === 'string');
    installedApps = valid.slice(0, 10);
  } else {
    installedApps = summaries.slice(0, 2).map((s) => summaryToInstalled(s));
    lsSet(LS.installed, installedApps);
  }
  try {
    const s = lsGet<unknown>(LS.settings, null);
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      demoSettingsSaved = Object.fromEntries(
        Object.entries(s as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>;
    } else {
      demoSettingsSaved = {};
    }
  } catch {
    demoSettingsSaved = {};
  }
}

// ---------------------------------------------------------------------------
// Minimal __TAURI_INTERNALS__ event system (invoke/listen/emit)
// ---------------------------------------------------------------------------

const demoCallbacks = new Map<number, (data: unknown) => void>();
const demoListeners = new Map<string, number[]>();
let nextCallbackId = 1;

function demoTransformCallback(cb?: (data: unknown) => void, once = false): number {
  const id = nextCallbackId;
  nextCallbackId = nextCallbackId >= 0x7fffffff ? 1 : nextCallbackId + 1;
  demoCallbacks.set(id, (data: unknown) => {
    if (once) demoCallbacks.delete(id);
    try {
      cb?.(data);
    } catch {
      // listener errors must not break the mock
    }
  });
  return id;
}

function demoRunCallback(id: number, data: unknown): void {
  const fn = demoCallbacks.get(id);
  if (fn) {
    fn(data);
  } else {
    console.warn(`[demo-mock] missing callback ${id}`);
  }
}

function demoUnregisterCallback(id: number): void {
  demoCallbacks.delete(id);
}

function demoUnregisterListener(event: string, eventId: number): void {
  const list = demoListeners.get(event);
  if (list) {
    const idx = list.indexOf(eventId);
    if (idx >= 0) list.splice(idx, 1);
  }
  demoUnregisterCallback(eventId);
}

function emitDemoEvent(event: string, payload: unknown): void {
  const ids = demoListeners.get(event) ?? [];
  for (const id of [...ids]) {
    demoRunCallback(id, { event, id, payload });
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Warn-once + shape-safe fallback
// ---------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(cmd: string): void {
  if (warned.has(cmd)) return;
  warned.add(cmd);
  console.warn(`[demo-mock] unmocked command "${cmd}" → shape-safe fallback`);
}

const LIST_FALLBACK = new Set([
  'search_apps',
  'search_apps_online',
  'enrich_trend_repos',
  'get_installed_apps',
  'check_for_updates',
  'get_mirror_status',
  'get_favorites',
  'get_category_apps',
  'scan_and_match_local_apps',
  'get_detected_installed_app_ids',
  'get_update_rules',
  'get_search_history',
  'get_recently_viewed_apps',
  'get_host_tokens',
  'search_forge_repos',
  'get_watched_apps',
]);

// ---------------------------------------------------------------------------
// Invoke router (views-touched commands)
// ---------------------------------------------------------------------------

type InvokeArgs = Record<string, unknown>;

function asRecord(args: unknown): InvokeArgs {
  if (args && typeof args === 'object' && !Array.isArray(args) && !(args instanceof ArrayBuffer)) {
    return args as InvokeArgs;
  }
  return {};
}

function argStr(a: InvokeArgs, ...keys: string[]): string {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string') return v;
  }
  return '';
}

function argNum(a: InvokeArgs, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/**
 * demo 侧确定性抖动（canonical 见 src/services/feed.ts：与 `hashSeeded01/balanced` 同形、
 * 同量级、同 seed 语义；允许 FNV 位宽实现不同。mock 层不做运行时 import，
 * 避免拉起 api.ts 破坏 install 时序，故此处解耦实现）。
 */
function demoSeeded01(id: string, seed: number): number {
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0;
  let h = (0x811c9dc5 ^ safeSeed) >>> 0;
  const s = String(id).toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function rankSummariesForFeed(seed: number, strategy?: unknown): AppSummary[] {
  // canonical balanced：log1p(stars) + (jitter01-0.5)*0.3（半幅 0.15，与 feed.ts / 后端 feed_score 同形同量级）。
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const normalized = String(strategy ?? 'balanced').trim().toLowerCase();
  const active = normalized === 'stars' ? 'stars' : normalized === 'fresh' ? 'fresh' : 'balanced';
  return summaries
    .map((s, index) => {
      const stars = Number.isFinite(s.stars) && s.stars > 0 ? s.stars : 0;
      const base = Math.log1p(stars);
      const jitter = demoSeeded01(s.id, safeSeed);
      const score =
        active === 'stars' ? base : active === 'fresh' ? jitter * 10 + base * 0.05 : base + (jitter - 0.5) * 0.3;
      return { s, index, score };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((x) => x.s);
}

// ---------------------------------------------------------------------------
// Trends demo fixtures (offline, deterministic, EXTERNAL hot list).
// `fetch_trends_text` routes by URL host; all three sources read from
// DEMO_EXTERNAL_TRENDS below — never from `summaries`/catalog.
// ---------------------------------------------------------------------------
// HARD RULES (trends-demo-v2, oracle C):
// 1. Catalog (`summaries`, catalog.json) MUST NOT source any board — boards
//    would otherwise mirror Discover (v1 overlapped 15-18/20 and was rejected).
//    Catalog is consulted ONLY by `enrich_trend_repos` (exact-hit passthrough).
// 2. Uncataloged rows render via synthetic fallback with is_verified=false;
//    the card distinguishes "not cataloged" by that flag, never by heuristics.
// 3. Board order uses ONLY change (rising) / forks+change aka healthyScore
//    (healthy); no stars weighting anywhere in trends fixtures.
// ---------------------------------------------------------------------------

/**
 * One row of the hardcoded external hot list. change/gain were derived once
 * (change = 2400 - slot*95 + (slot*37 % 41), strictly decreasing down the
 * table; gain = 180 + ((slot*613 + 97) % 1500)) and are now frozen literals,
 * so fixtures stay byte-stable with zero catalog input.
 */
interface DemoExternalTrend {
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

const DEMO_EXTERNAL_TRENDS: readonly DemoExternalTrend[] = [
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

/** Escape text for embedding in demo trending HTML. */
function escapeTrendHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Keep href identity segments inside the `parseTrendingHtml` charset
 * (`[A-Za-z0-9_.-]` per segment) so two-segment `a[href="/owner/repo"]`
 * matching never breaks. No-op on the bundled catalog (all 360 coords
 * already clean), hence enrich keys stay exact.
 */
function demoTrendPathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9_.-]+/g, '-') || 'repo';
}

/** Board -> trending `?since=` increment suffix, shared by parse + render (single source, no repeated switch). */
const DEMO_TREND_SINCE_SUFFIX = { daily: 'today', weekly: 'this week', monthly: 'this month' } as const;

type DemoTrendSince = keyof typeof DEMO_TREND_SINCE_SUFFIX;

/** `?since=` of a trending URL -> daily|weekly|monthly (default daily). */
function demoTrendingSince(url: string): DemoTrendSince {
  const token = /[?&]since=(daily|weekly|monthly)/i.exec(url)?.[1]?.toLowerCase();
  return token === 'weekly' || token === 'monthly' ? token : 'daily';
}

/** Card gradient for synthetic fallback by category (dev slate, ai violet). */
function demoFallbackGradient(cat: string): string {
  if (cat === 'ai') return 'linear-gradient(135deg, #7c3aed, #4c1d95)';
  return 'linear-gradient(135deg, #475569, #334155)';
}

/**
 * Synthetic enrich fallback for external coords missing from catalog.
 * Mirrors `fallback_summary` shape, but grants platforms ['windows'] so demo
 * cards render immediately. DEMO ONLY — production treats empty platforms as
 * pending ([]待确认) and never fabricates them; this drift is intentional for
 * the offline embed.
 */
function demoExternalFallback(t: DemoExternalTrend): AppSummary {
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

/** Table lookup by coord (case-insensitive), shared by enrich fallback. */
function findExternalTrend(owner: string, repo: string): DemoExternalTrend | undefined {
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  return DEMO_EXTERNAL_TRENDS.find((t) => t.owner.toLowerCase() === o && t.repo.toLowerCase() === r);
}

/**
 * Offline github.com/trending HTML: DEMO_EXTERNAL_TRENDS[0, 20), one
 * `article.Box-row` per repo with a two-segment identity link, `<p>`
 * description, stargazers/forks totals and a `<span>` increment matching the
 * `parseTrendingHtml` grammar (`N stars today|this week|this month`).
 */
function buildDemoTrendingHtml(url: string): string {
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

/**
 * Offline doforce JSON: DEMO_EXTERNAL_TRENDS[2, 22) as a bare array of
 * `{repo, desc, lang, stars, forks, change}`. `change` is frozen strictly
 * decreasing down the table, so rising (change desc) reproduces table order
 * while healthy (forks + change desc) scrambles on the non-monotone forks.
 */
function buildDemoDoforceJson(): string {
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

/**
 * Offline GitHub Search JSON: DEMO_EXTERNAL_TRENDS[4, 24) as
 * `{items: [{full_name, stargazers_count, forks_count, description, html_url}]}`.
 * Staggered windows (0/2/4) give the boards variety while sharing one source.
 */
function buildDemoGitHubSearchJson(): string {
  const items = DEMO_EXTERNAL_TRENDS.slice(4, 24).map((t) => ({
    full_name: `${t.owner}/${t.repo}`,
    stargazers_count: t.stars,
    forks_count: t.forks,
    description: t.desc,
    html_url: `https://github.com/${t.owner}/${t.repo}`,
  }));
  return JSON.stringify({ items });
}

/** Offline router for `fetch_trends_text`: external-table fixtures by URL; unknown URLs keep the legacy `''`. */
function demoTrendsTextForUrl(url: string): string {
  if (url.includes('github.com/trending')) return buildDemoTrendingHtml(url);
  if (url.includes('trend.doforce.dpdns.org')) return buildDemoDoforceJson();
  if (url.includes('api.github.com/search')) return buildDemoGitHubSearchJson();
  return '';
}

async function demoInvoke(cmd: string, args?: unknown): Promise<unknown> {
  // Event plugin channel (listen/emit/unlisten) — backing for all on* subscriptions.
  if (cmd === 'plugin:event|listen') {
    const a = asRecord(args);
    const event = argStr(a, 'event');
    const handler = a['handler'];
    if (typeof handler === 'number' && event) {
      const list = demoListeners.get(event) ?? [];
      list.push(handler);
      demoListeners.set(event, list);
      return handler;
    }
    return 0;
  }
  if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
    const a = asRecord(args);
    const event = argStr(a, 'event');
    if (event) emitDemoEvent(event, a['payload']);
    return null;
  }
  if (cmd === 'plugin:event|unlisten') {
    const a = asRecord(args);
    const event = argStr(a, 'event');
    const id = a['eventId'] ?? a['event_id'];
    if (event && typeof id === 'number') demoUnregisterListener(event, id);
    return null;
  }

  // Silent no-op stubs for desktop-only plugins (log/updater/window/webview/app/dialog).
  if (cmd.startsWith('plugin:log|')) {
    return null;
  }
  if (cmd === 'plugin:updater|check') {
    return null; // demo client is always "latest"
  }
  if (cmd.startsWith('plugin:window|')) {
    if (cmd.includes('is_maximized')) return false;
    if (cmd.includes('is_visible') || cmd.includes('is_focused')) return true;
    return null;
  }
  if (
    cmd.startsWith('plugin:webview|') ||
    cmd.startsWith('plugin:app|') ||
    cmd.startsWith('plugin:dialog|') ||
    cmd.startsWith('plugin:process|') ||
    cmd.startsWith('plugin:resources|') ||
    cmd.startsWith('plugin:opener|')
  ) {
    if (cmd === 'plugin:app|version' || cmd === 'plugin:app|get_version') return '0.5.0-demo';
    if (cmd === 'plugin:app|name' || cmd === 'plugin:app|get_name') return 'Z-Store Demo';
    return null;
  }

  const a = asRecord(args);

  switch (cmd) {
    // -- search ------------------------------------------------------------
    case 'search_apps': {
      const q = argStr(a, 'query').trim().toLowerCase();
      const matched = !q
        ? [...summaries]
        : summaries.filter((s) =>
            `${s.id} ${s.name} ${s.description} ${s.description_en ?? ''} ${s.owner} ${s.repo} ${s.category_name}`.toLowerCase().includes(q),
          );
      // 后端契约：search_apps 可选 limit/offset（不传即全量，保持老行为）。
      const limit = argNum(a, 'limit');
      const offset = argNum(a, 'offset');
      if (limit === undefined && offset === undefined) return matched;
      const start = Math.max(0, Math.floor(offset ?? 0));
      const len = limit === undefined ? matched.length - start : Math.max(0, Math.floor(limit));
      return matched.slice(start, start + len);
    }
    case 'get_home_feed': {
      // 后端契约：get_home_feed(limit, offset, seed?, strategy?) -> { items, total, has_more }。
      // demo 按 feed.ts 同语义三策略排序后分页：stars 纯星数、balanced 轻扰动、fresh 抖动主导；
      // strategy 缺省/非法回退 balanced，换 seed 即换一批，行为与本地 rankFeed 对齐。
      const limit = Math.min(100, Math.max(1, Math.floor(argNum(a, 'limit') ?? 20)));
      const offset = Math.max(0, Math.floor(argNum(a, 'offset') ?? 0));
      const seed = Math.floor(argNum(a, 'seed') ?? 0);
      const ranked = rankSummariesForFeed(seed, a['strategy']);
      const items = ranked.slice(offset, offset + limit);
      return { items, total: ranked.length, has_more: offset + items.length < ranked.length };
    }
    case 'search_apps_online': {
      // 后端契约：search_apps_online(query, search_id?, page?=1, per_page?=12，钳制 1-50)，
      // 直查单条仍只回 1 条（page>1 回空）。demo 用本地 catalog 同形分页模拟远端翻页。
      const qRaw = argStr(a, 'query').trim();
      if (!qRaw) return [];
      const rawPer = argNum(a, 'per_page', 'perPage', 'per-page');
      const rawPage = argNum(a, 'page');
      const perPage =
        rawPer === undefined ? 12 : Math.min(50, Math.max(1, Math.floor(rawPer)));
      const page =
        rawPage === undefined || !Number.isFinite(rawPage) || Math.floor(rawPage) < 1
          ? 1
          : Math.floor(rawPage);
      // 直查：owner/repo 精确命中只回 1 条，不受 per_page 影响。
      if (qRaw.includes('/')) {
        const exact = findSummary(qRaw);
        if (exact) return page === 1 ? [exact] : [];
      }
      const q = qRaw.toLowerCase();
      const matched = summaries.filter((s) =>
        `${s.id} ${s.name} ${s.description} ${s.description_en ?? ''} ${s.owner} ${s.repo} ${s.category_name}`.toLowerCase().includes(q),
      );
      const start = (page - 1) * perPage;
      return matched.slice(start, start + perPage);
    }
    case 'enrich_trend_repos': {
      // Catalog exact hit passes through untouched (real verified state).
      // Otherwise the external hot-list coord resolves to a synthetic fallback —
      // enrich never returns null for a well-formed coord in the demo.
      // DEMO ONLY: fallback grants platforms so cards render (production keeps [] pending).
      const repos = Array.isArray(a['repos']) ? (a['repos'] as Array<{ owner?: string; repo?: string }>) : [];
      return repos.map((r) => {
        const owner = String(r?.owner ?? '').trim();
        const repo = String(r?.repo ?? '').trim();
        if (!owner || !repo) return null;
        const o = owner.toLowerCase();
        const ro = repo.toLowerCase();
        const hit =
          summaries.find((s) => s.owner.toLowerCase() === o && s.repo.toLowerCase() === ro) ?? null;
        if (hit) return hit;
        const ext = findExternalTrend(o, ro);
        if (ext) return demoExternalFallback(ext);
        return demoExternalFallback({
          owner,
          repo,
          desc: `${owner}/${repo}`,
          lang: 'TypeScript',
          stars: 0,
          forks: 0,
          change: 0,
          gain: 0,
          cat: 'dev',
          catn: '开发工具',
        });
      });
    }
    case 'get_platforms_lite': {
      const id = argStr(a, 'id', 'appId', 'app_id');
      const hit = findSummary(id);
      if (hit) {
        return {
          id: hit.id,
          platforms: [...(hit.platforms ?? [])],
          from_cache: true,
          is_stale: null,
        };
      }
      // 未收录坐标：stale pending（永不返回 null，避免调用方误确认为 Other）。
      return { id, platforms: [], is_stale: true, from_cache: false };
    }

    // -- catalog / details / icons / readme --------------------------------
    case 'get_app_details': {
      const id = argStr(a, 'id', 'appId', 'app_id');
      const hit = findSummary(id);
      if (!hit) throw new Error(`demo: unknown app "${id}"`);
      return toDetail(hit);
    }
    case 'get_readme_variants': {
      const id = argStr(a, 'appId', 'app_id', 'id');
      const hit = findSummary(id);
      const name = hit?.name ?? id;
      const zh = `# ${name}\n\n${hit?.description ?? ''}\n\n> Live-demo bundle: full README unavailable offline.`;
      const en = `# ${name}\n\n${hit?.description_en ?? hit?.description ?? ''}\n\n> Live-demo bundle.`;
      const result: ReadmeVariantsResult = {
        variants: [
          { lang: 'zh-CN', path: 'README.md', markdown: zh },
          { lang: 'en-US', path: 'README.en.md', markdown: en },
        ],
      };
      return result;
    }
    case 'get_app_icon_cycle':
    case 'cycle_app_icon': {
      const id = argStr(a, 'appId', 'app_id', 'id');
      const hit = findSummary(id);
      if (!hit) return null;
      const key = hit.id.toLowerCase();
      const level = cmd === 'cycle_app_icon' ? (iconLevel.get(key) ?? 0) + 1 : (iconLevel.get(key) ?? 0);
      if (cmd === 'cycle_app_icon') iconLevel.set(key, level);
      const result: AppIconCycleResult = {
        url: hit.icon,
        level,
        source: 'catalog',
        remote_url: hit.icon,
        is_fallback: false,
        total_levels: 1,
        is_cataloged: true,
      };
      return result;
    }
    case 'get_or_fetch_icon': {
      const remote = argStr(a, 'remoteUrl', 'remote_url');
      if (remote) return remote;
      const appId = argStr(a, 'appId', 'app_id');
      return findSummary(appId)?.icon ?? '';
    }

    // -- install lifecycle (fake progress via emit timer) -------------------
    case 'install_app': {
      const appId = argStr(a, 'appId', 'app_id', 'id');
      const hit = findSummary(appId);
      if (!hit) throw new Error(`demo: unknown app "${appId}"`);
      const total = 20 * 1024 * 1024;
      for (let step = 1; step <= 5; step += 1) {
        const payload: DownloadProgressPayload = {
          task_id: hit.id,
          downloaded_bytes: Math.floor((total * step) / 5),
          total_bytes: total,
          speed_bytes_per_sec: 5 * 1024 * 1024,
          state: 'downloading',
        };
        emitDemoEvent('zstore://download-progress', payload);
        await delay(220);
      }
      const done: DownloadProgressPayload = {
        task_id: hit.id,
        downloaded_bytes: total,
        total_bytes: total,
        speed_bytes_per_sec: 5 * 1024 * 1024,
        state: 'verified',
      };
      emitDemoEvent('zstore://download-progress', done);
      const installed: InstalledApp = {
        ...summaryToInstalled(hit),
        installed_at: Math.floor(Date.now() / 1000),
        asset_name: typeof a['assetName'] === 'string' && a['assetName'] ? String(a['assetName']) : `${hit.repo}-${hit.latest_version}-windows-x64.msi`,
      };
      installedApps = [...installedApps.filter((i) => i.app_id.toLowerCase() !== hit.id.toLowerCase()), installed];
      lsSet(LS.installed, installedApps);
      return installed;
    }
    case 'download_asset': {
      const appId = argStr(a, 'appId', 'app_id', 'id');
      const assetName = argStr(a, 'assetName', 'asset_name') || `${appId || 'app'}-demo.msi`;
      const result: DownloadAssetResult = {
        file_path: `C:\\Users\\Demo\\Downloads\\${assetName}`,
        file_name: assetName,
        dir: 'C:\\Users\\Demo\\Downloads',
        sha256: 'demo',
        verified: true,
      };
      return result;
    }
    case 'uninstall_app': {
      const appId = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      installedApps = installedApps.filter((i) => i.app_id.toLowerCase() !== appId);
      lsSet(LS.installed, installedApps);
      return true;
    }
    case 'unmanage_app': {
      const appId = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      installedApps = installedApps.filter((i) => i.app_id.toLowerCase() !== appId);
      lsSet(LS.installed, installedApps);
      return true;
    }
    case 'launch_app':
    case 'open_folder':
    case 'show_file_in_folder':
      return true;
    case 'open_url': {
      const url = argStr(a, 'url').trim();
      // Best-effort real open via the native opener captured before lockdown hijack.
      try {
        const native = (window as unknown as { __ZSTORE_DEMO_NATIVE_OPEN__?: typeof window.open }).__ZSTORE_DEMO_NATIVE_OPEN__;
        if (url && /^https?:\/\//i.test(url) && typeof native === 'function') {
          native.call(window, url, '_blank', 'noopener,noreferrer');
        }
      } catch {
        // no-op in sandbox
      }
      return null;
    }

    // -- favorites / watch / star (localStorage Sets) -----------------------
    case 'get_favorites':
      return summaries.filter((s) => favSet.has(s.id.toLowerCase())).map((s) => s.id);
    case 'toggle_favorite': {
      const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      if (!id) return false;
      if (favSet.has(id)) favSet.delete(id);
      else favSet.add(id);
      persistSets();
      return favSet.has(id);
    }
    case 'get_watched_apps':
      return [...watchSet].map((id) => ({ app_id: id }));
    case 'watch_app': {
      const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      if (id) {
        watchSet.add(id);
        persistSets();
      }
      return true;
    }
    case 'unwatch_app': {
      const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      watchSet.delete(id);
      persistSets();
      return true;
    }
    case 'star_app': {
      const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      if (id) {
        starSet.add(id);
        persistSets();
      }
      const result: StarAppResult = { starred: true, in_list: true };
      return result;
    }
    case 'unstar_app': {
      const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      starSet.delete(id);
      persistSets();
      return true;
    }
    case 'is_starred': {
      const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      return starSet.has(id);
    }

    // -- search history / recent views (localStorage) ------------------------
    case 'record_search_query': {
      const q = argStr(a, 'query').trim();
      if (q) {
        searchHistory = [q, ...searchHistory.filter((x) => x !== q)].slice(0, 20);
        lsSet(LS.searchHistory, searchHistory);
      }
      return null;
    }
    case 'get_search_history':
      return [...searchHistory];
    case 'clear_search_history':
      searchHistory = [];
      lsSet(LS.searchHistory, searchHistory);
      return null;
    case 'remove_search_query': {
      const q = argStr(a, 'query');
      searchHistory = searchHistory.filter((x) => x !== q);
      lsSet(LS.searchHistory, searchHistory);
      return null;
    }
    case 'record_app_view': {
      const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
      if (id) {
        recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, 20);
        lsSet(LS.recentViews, recentIds);
      }
      return null;
    }
    case 'get_recently_viewed_apps': {
      const out: AppSummary[] = [];
      for (const id of recentIds) {
        const hit = findSummary(id);
        if (hit) out.push(hit);
      }
      return out;
    }
    case 'clear_view_history':
      recentIds = [];
      lsSet(LS.recentViews, recentIds);
      return null;

    // -- static demo values ---------------------------------------------------
    case 'get_installed_apps':
      return [...installedApps];
    case 'get_category_apps': {
      const category = argStr(a, 'category').toLowerCase();
      if (!category) return [];
      return summaries.filter((s) => s.category.toLowerCase() === category);
    }
    case 'get_catalog_count':
      return summaries.length;
    case 'get_mirror_status':
      return demoMirrors;
    case 'switch_mirror':
      return true;
    case 'check_for_updates':
      return buildDemoUpdates(installedApps);

    // -- startup-critical minimal stubs (fail soft, keep App rendering) -------
    // Demo display defaults: first-run get_settings returns embed density
    // (ui_scale 90 / font_size 12, URL-aware) instead of desktop 100/14.
    case 'get_settings': {
      const display = resolveDemoDisplayDefaults();
      return { ui_scale: display.ui_scale, font_size: display.font_size };
    }
    case 'save_setting': {
      const key = argStr(a, 'key');
      const value = a['value'];
      if (key && typeof value !== 'undefined') {
        demoSettingsSaved[key] = String(value);
        lsSet(LS.settings, demoSettingsSaved);
      }
      return true;
    }
    case 'get_detected_installed_app_ids':
      return installedApps.map((i) => i.app_id);
    case 'import_single_app': {
      const id = argStr(a, 'appId', 'app_id', 'id');
      const hit = findSummary(id);
      if (hit && !installedApps.some((i) => i.app_id.toLowerCase() === hit.id.toLowerCase())) {
        installedApps = [...installedApps, summaryToInstalled(hit)];
        lsSet(LS.installed, installedApps);
      }
      return true;
    }
    case 'get_update_rules':
      return [];
    case 'set_app_skip_version':
    case 'set_app_frozen':
    case 'set_app_hidden':
    case 'remove_update_rule':
      return true;
    case 'register_deep_link_scheme':
      return true;
    case 'get_cli_deep_link':
      return null;
    case 'handle_deep_link':
      throw new Error('demo: deep links are disabled in the live demo');
    case 'sync_catalog': {
      const result: SyncCatalogResult = {
        updated: false,
        count: summaries.length,
        message: 'demo: bundled catalog is up to date',
      };
      return result;
    }
    case 'select_folder':
      return null;
    case 'test_proxy': {
      const result: ProxyTestResult = { success: true, latency_ms: 80, message: 'demo' };
      return result;
    }
    case 'fetch_trends_text': {
      // Offline deterministic fixtures by URL host (catalog-backed, so every
      // repo enriches). Unknown URLs keep the legacy '' and never throw.
      return demoTrendsTextForUrl(argStr(a, 'url'));
    }
    case 'scan_and_match_local_apps':
      return [];
    case 'import_matched_apps':
      return 0;
    case 'get_developer_profile': {
      const login = argStr(a, 'developer', 'login') || 'demo';
      const profile: DeveloperProfile = {
        login,
        avatar_url: '',
        html_url: `https://github.com/${login}`,
        public_repos: 0,
        followers: 0,
        following: 0,
        repos: [],
      };
      return profile;
    }
    case 'sync_github_starred': {
      const result: StarredSyncResult = { total_starred: 0, catalog_matches: [], other_repos: [] };
      return result;
    }
    case 'get_host_tokens':
      return [];
    case 'set_host_token':
    case 'remove_host_token':
      return null;
    case 'refresh_host_rate_limit': {
      const host = argStr(a, 'host') || 'github.com';
      const entry: HostTokenEntry = { host, token: '', updated_at: Math.floor(Date.now() / 1000) };
      return entry;
    }
    case 'test_host_connection': {
      const host = argStr(a, 'host') || 'github.com';
      const status: HostRateLimitStatus = { host, is_connected: false, message: 'demo' };
      return status;
    }
    case 'search_forge_repos':
      return [];
    case 'get_oauth_user':
      return null;
    case 'oauth_logout':
      return true;
    case 'oauth_device_start':
    case 'oauth_device_poll':
      throw new Error('demo: GitHub OAuth is disabled in the live demo');
    case 'import_user_data': {
      const counts: ImportUserDataCounts = {
        favorites_added: 0,
        watched_added: 0,
        settings_applied: false,
        installed_skipped: 0,
      };
      return counts;
    }

    default:
      warnOnce(cmd);
      if (LIST_FALLBACK.has(cmd)) return [];
      if (cmd === 'get_catalog_count' || cmd === 'import_matched_apps') return 0;
      return null;
  }
}

// ---------------------------------------------------------------------------
// Installer (idempotent, must run BEFORE services/api evaluates isTauri)
// ---------------------------------------------------------------------------

export function installDemoMock(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w['__ZSTORE_DEMO_MOCK__']) return;

  // Capture the native opener before browserLockdown hijacks window.open,
  // so demo `open_url` can still pop real tabs for external links.
  try {
    if (typeof w['__ZSTORE_DEMO_NATIVE_OPEN__'] !== 'function' && typeof window.open === 'function') {
      w['__ZSTORE_DEMO_NATIVE_OPEN__'] = window.open.bind(window);
    }
  } catch {
    // ignore
  }

  hydrate();

  if (
    DEMO_DISPLAY_DEFAULTS_MARKER !==
    `zstore:demo:display-defaults:ui_scale=${DEMO_UI_SCALE}:font_size=${DEMO_FONT_SIZE}`
  ) {
    throw new Error('[demo-mock] display-defaults marker drifted from DEMO_UI_SCALE / DEMO_FONT_SIZE');
  }

  const internals = {
    invoke: (cmd: string, args?: unknown) => demoInvoke(cmd, args),
    transformCallback: (cb?: (data: unknown) => void, once = false) => demoTransformCallback(cb, once),
    unregisterCallback: (id: number) => demoUnregisterCallback(id),
    runCallback: (id: number, data: unknown) => demoRunCallback(id, data),
    callbacks: demoCallbacks,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    convertFileSrc: (filePath: string, protocol = 'asset') => {
      try {
        return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
      } catch {
        return filePath;
      }
    },
  };

  w['__TAURI_INTERNALS__'] = internals;
  (w as Record<string, unknown>)['__TAURI_EVENT_PLUGIN_INTERNALS__'] = {
    unregisterListener: (event: string, eventId: number) => demoUnregisterListener(event, eventId),
  };
  try {
    w['__ZSTORE_DEMO_DISPLAY_DEFAULTS__'] = DEMO_DISPLAY_DEFAULTS_MARKER;
  } catch {
    // ignore — marker is best-effort for build greppability
  }
  w['__ZSTORE_DEMO_MOCK__'] = true;
}

// Auto-install on import when built with VITE_DEMO (covers the static-import
// ordering path: mock evaluates before services/api, so isTauri sees it).
// The main.tsx demo branch ALSO calls installDemoMock() explicitly after a
// dynamic import — both paths are idempotent.
if (typeof window !== 'undefined') {
  try {
    const flag = (import.meta as unknown as { env?: Record<string, unknown> }).env?.['VITE_DEMO'];
    if (flag) installDemoMock();
  } catch {
    // never break module evaluation
  }
}
