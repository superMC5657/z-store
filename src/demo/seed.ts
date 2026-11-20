import type { DraftEntryWire, DraftItemWire, DraftStatus } from '../services/custom';
import type { InstalledApp, UpdateRule, WatchDismissedEntry, WatchUpdatedPayload } from '../types';
import { findSummary } from './fixtures';
import { DAY_SECS } from './handlers/common';

/**
 * 演示站初始种子数据：首次访问时由 `demoState.seedFirstVisit` 写入 localStorage，
 * 版本号由目录数据动态派生以保持自洽。
 */

// ---------------------------------------------------------------------------
// 已安装
// ---------------------------------------------------------------------------

/** 后端实际写入的 `install_method`：资产类型（`asset.kind`）或本机扫描导入。 */
type SeedInstallMethod = 'msi' | 'setup_exe' | 'portable_zip' | 'system_import';

interface SeedInstall {
  id: string;
  method: SeedInstallMethod;
  /** 距今多少天前安装 */
  daysAgo: number;
  /** true：已装版本落后目录一个版本，会出现在「有更新」里（除非被规则拦下） */
  outdated?: boolean;
}

const SEED_INSTALLS: readonly SeedInstall[] = [
  { id: 'microsoft/powertoys', method: 'msi', daysAgo: 9, outdated: true },
  { id: 'rustdesk/rustdesk', method: 'setup_exe', daysAgo: 21 },
  { id: 'localsend/localsend', method: 'msi', daysAgo: 3, outdated: true },
  { id: 'clash-verge-rev/clash-verge-rev', method: 'setup_exe', daysAgo: 40 },
  { id: 'qbittorrent/qbittorrent', method: 'setup_exe', daysAgo: 75, outdated: true },
  { id: 'obsproject/obs-studio', method: 'setup_exe', daysAgo: 14, outdated: true },
  { id: 'videolan/vlc', method: 'msi', daysAgo: 120 },
  { id: 'keepassxreboot/keepassxc', method: 'msi', daysAgo: 58 },
  { id: 'microsoft/vscode', method: 'setup_exe', daysAgo: 6, outdated: true },
  { id: 'neovim/neovim', method: 'portable_zip', daysAgo: 33 },
  { id: 'alacritty/alacritty', method: 'msi', daysAgo: 88, outdated: true },
  { id: 'sharex/sharex', method: 'portable_zip', daysAgo: 150 },
  { id: 'upscayl/upscayl', method: 'setup_exe', daysAgo: 27 },
  { id: 'logseq/logseq', method: 'setup_exe', daysAgo: 19 },
  { id: 'laurent22/joplin', method: 'setup_exe', daysAgo: 11, outdated: true },
  { id: 'dbeaver/dbeaver', method: 'msi', daysAgo: 65 },
  { id: 'koodo-reader/koodo-reader', method: 'system_import', daysAgo: 47 },
  { id: 'prismlauncher/prismlauncher', method: 'portable_zip', daysAgo: 96 },
  { id: 'ql-win/quicklook', method: 'system_import', daysAgo: 200 },
  { id: 'agalwood/motrix', method: 'system_import', daysAgo: 70 },
];

/** 最后一个非零数字段 -1（`release-5.3.0` → `release-5.2.0`，`v1.18.2` → `v1.18.1`）；全为 0 时原样返回。 */
export function previousVersion(version: string): string {
  const runs = [...version.matchAll(/\d+/g)];
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    const n = Number(run[0]);
    if (n > 0 && run.index !== undefined) {
      return `${version.slice(0, run.index)}${n - 1}${version.slice(run.index + run[0].length)}`;
    }
  }
  return version;
}

const ASSET_EXT: Record<SeedInstallMethod, string> = {
  msi: 'msi',
  setup_exe: 'exe',
  portable_zip: 'zip',
  system_import: '',
};

function installPath(method: SeedInstallMethod, name: string): string {
  if (method === 'portable_zip') return `D:\\Tools\\${name}`;
  if (method === 'system_import') return `C:\\Users\\Demo\\AppData\\Local\\Programs\\${name}`;
  return `C:\\Program Files\\${name}`;
}

export function buildSeedInstalled(now: number): InstalledApp[] {
  const out: InstalledApp[] = [];
  SEED_INSTALLS.forEach((seed, i) => {
    const s = findSummary(seed.id);
    if (!s) return;
    const version = seed.outdated ? previousVersion(s.latest_version) : s.latest_version;
    const imported = seed.method === 'system_import';
    out.push({
      app_id: s.id,
      app_name: s.name,
      version,
      installed_at: now - seed.daysAgo * DAY_SECS - i * 3600,
      install_method: seed.method,
      install_path: installPath(seed.method, s.name),
      // 扫描导入没有下载过资产，与后端一致留空
      asset_name: imported ? '' : `${s.repo}-${version}-windows-x64.${ASSET_EXT[seed.method]}`,
      asset_sha256: imported ? '' : 'demo',
      icon: s.icon,
      icon_bg: s.icon_bg,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// 星标 / 关注 / 最近浏览 / 搜索历史
// ---------------------------------------------------------------------------

export const SEED_FAVORITES: readonly string[] = [
  'rustdesk/rustdesk', 'localsend/localsend', 'obsproject/obs-studio', 'keepassxreboot/keepassxc',
  'neovim/neovim', 'upscayl/upscayl', 'logseq/logseq', 'zotero/zotero', 'prismlauncher/prismlauncher',
  'zed-industries/zed',
];

export const SEED_WATCHED: readonly string[] = [
  'microsoft/powertoys', 'clash-verge-rev/clash-verge-rev', 'dbeaver/dbeaver', 'openai/codex',
  'ghostty-org/ghostty', 'koreader/koreader',
];

export const SEED_RECENT_VIEWS: readonly string[] = [
  'zed-industries/zed', 'obsproject/obs-studio', 'zotero/zotero', 'hoppscotch/hoppscotch',
  'localsend/localsend', 'ventoy/ventoy', 'blender/blender', 'kicad/kicad-source-mirror', 'iina/iina',
];

export function buildSeedRecentViewTimes(now: number): Record<string, number> {
  const times: Record<string, number> = {};
  SEED_RECENT_VIEWS.forEach((id, i) => {
    times[id.toLowerCase()] = now - (i * 5400 + 600);
  });
  return times;
}

export const SEED_SEARCH_HISTORY: readonly string[] = [
  'obs', '下载器', 'password manager', 'markdown', '远程桌面', 'screen recorder', 'git', 'emulator',
];

// 更新规则：覆盖锁定 / 隐藏 / 跳过版本样例

export function buildSeedUpdateRules(now: number): UpdateRule[] {
  const at = now - 3 * DAY_SECS;
  const obsLatest = findSummary('obsproject/obs-studio')?.latest_version ?? null;
  return [
    { app_id: 'microsoft/vscode', is_frozen: true, is_hidden: false, skipped_version: null, updated_at: at },
    { app_id: 'videolan/vlc', is_frozen: true, is_hidden: false, skipped_version: null, updated_at: at - 3600 },
    { app_id: 'alacritty/alacritty', is_frozen: false, is_hidden: true, skipped_version: null, updated_at: at - 7200 },
    { app_id: 'ql-win/quicklook', is_frozen: false, is_hidden: true, skipped_version: null, updated_at: at - 10800 },
    // 跳过的正是目录最新版：OBS 落后但不提示更新
    { app_id: 'obsproject/obs-studio', is_frozen: false, is_hidden: false, skipped_version: obsLatest, updated_at: at - 14400 },
  ];
}

// ---------------------------------------------------------------------------
// 关注提醒：关注的应用发布了新版本（待处理 + 已「知道了」）
// ---------------------------------------------------------------------------

export interface SeedWatchNotifications {
  pending: WatchUpdatedPayload[];
  dismissed: WatchDismissedEntry[];
}

const SEED_WATCH_PENDING: readonly string[] = ['openai/codex', 'clash-verge-rev/clash-verge-rev', 'koreader/koreader'];
const SEED_WATCH_DISMISSED: readonly string[] = ['dbeaver/dbeaver'];

export function buildSeedWatchNotifications(now: number): SeedWatchNotifications {
  const pending: WatchUpdatedPayload[] = [];
  for (const id of SEED_WATCH_PENDING) {
    const s = findSummary(id);
    if (s) pending.push({ app_id: s.id, version: s.latest_version });
  }
  const dismissed: WatchDismissedEntry[] = [];
  SEED_WATCH_DISMISSED.forEach((id, i) => {
    const s = findSummary(id);
    if (s) dismissed.push({ app_id: s.id, version: s.latest_version, dismissed_at: now - (i + 2) * DAY_SECS });
  });
  return { pending, dismissed };
}

// 待收录（`custom_apps`）：覆盖草稿 / 已收录 / 已提交 / 已归档四组

/** 清单仓库收录 Issue 列表（与后端 `CATALOG_REPO_ISSUES_URL` 同仓）。 */
const CATALOG_REPO_ISSUES = 'https://github.com/superMC5657/z-store-catalog/issues';

interface SeedCustomApp {
  owner: string;
  repo: string;
  name: string;
  description: string;
  description_en: string;
  category: string;
  category_name: string;
  aliases: string[];
  version: string;
  license: string;
  homepage: string | null;
  stars: number;
  forks: number;
  /** L2 品牌库 / L3 仓库图标的离线探测结果（与应用图标策略一致）。 */
  icon: string;
  icon_bg: string;
  platforms: string[];
  identifiers: Record<string, string[]>;
  status: Exclude<DraftStatus, 'local_collected'>;
  archived?: boolean;
  /** 创建距今天数 */
  daysAgo: number;
}

const SEED_CUSTOM_APPS: readonly SeedCustomApp[] = [
  {
    owner: 'CherryHQ', repo: 'cherry-studio', name: 'Cherry Studio',
    description: '支持多家大模型服务商的桌面 AI 客户端，内置知识库、助手与 MCP 工具。',
    description_en: 'A desktop AI client with multi-provider LLM support, knowledge bases and MCP tools.',
    category: 'dev', category_name: '开发编程', aliases: ['ai 客户端', 'chatgpt', 'llm', 'cherry'],
    version: 'v1.5.0', license: 'AGPL-3.0', homepage: 'https://www.cherry-ai.com', stars: 36000, forks: 3400,
    icon: 'https://raw.githubusercontent.com/CherryHQ/cherry-studio/main/build/icon.png',
    icon_bg: 'linear-gradient(135deg, #f43f5e, #be123c)', platforms: ['windows', 'macos', 'linux'],
    identifiers: { windows: ['Cherry Studio.exe'], macos: ['Cherry Studio.app'], linux: ['cherry-studio'] },
    status: 'draft', daysAgo: 2,
  },
  {
    owner: 'dyad-sh', repo: 'dyad', name: 'Dyad',
    description: '本地运行的开源 AI 应用构建器，用自然语言生成并迭代全栈应用。',
    description_en: 'A free, local, open-source AI app builder.',
    category: 'dev', category_name: '开发编程', aliases: ['ai 应用构建', 'app builder', 'vibe coding'],
    version: 'v0.20.0', license: 'Apache-2.0', homepage: 'https://dyad.sh', stars: 19000, forks: 2100,
    icon: 'https://raw.githubusercontent.com/dyad-sh/dyad/main/assets/icon/logo.png',
    icon_bg: 'linear-gradient(135deg, #8b5cf6, #6d28d9)', platforms: ['windows', 'macos', 'linux'],
    identifiers: { windows: ['dyad.exe'], macos: ['dyad.app'], linux: ['dyad'] },
    status: 'draft', daysAgo: 1,
  },
  {
    // 草稿允许占位协议：演示「补真实 SPDX 后才能收录」
    owner: 'gitbutlerapp', repo: 'gitbutler', name: 'GitButler',
    description: '以虚拟分支为核心的现代 Git 客户端，可同时在多条分支上并行工作。',
    description_en: 'The GitButler version control client, backed by Git, powered by Tauri/Rust/Svelte.',
    category: 'dev', category_name: '开发编程', aliases: ['git 客户端', '虚拟分支', 'version control'],
    version: 'release/0.15.0', license: 'NOASSERTION', homepage: 'https://gitbutler.com', stars: 15500, forks: 700,
    icon: 'https://raw.githubusercontent.com/gitbutlerapp/gitbutler/master/crates/gitbutler-tauri/icons/release/icon.png',
    icon_bg: 'linear-gradient(135deg, #f59e0b, #d97706)', platforms: ['windows', 'macos', 'linux'],
    identifiers: { windows: ['GitButler.exe'], macos: ['GitButler.app'], linux: ['gitbutler'] },
    status: 'draft', daysAgo: 8,
  },
  {
    owner: 'tw93', repo: 'Pake', name: 'Pake',
    description: '用 Rust 一键把任意网页打包成轻量桌面应用，体积仅为 Electron 的几十分之一。',
    description_en: 'Turn any webpage into a desktop app with Rust, much lighter than Electron.',
    category: 'dev', category_name: '开发编程', aliases: ['网页打包', 'tauri', '桌面应用'],
    version: 'V3.2.0', license: 'MIT', homepage: 'https://pake.dev', stars: 42000, forks: 2200,
    icon: 'https://raw.githubusercontent.com/tw93/Pake/main/assets/logo.png',
    icon_bg: 'linear-gradient(135deg, #38bdf8, #0284c7)', platforms: ['windows', 'macos', 'linux'],
    identifiers: { windows: ['pake.exe'], macos: ['Pake.app'], linux: ['pake'] },
    status: 'collected', daysAgo: 5,
  },
  {
    owner: 'TagStudioDev', repo: 'TagStudio', name: 'TagStudio',
    description: '以标签而非文件夹来组织本地文件的跨平台资源管理器。',
    description_en: 'A User-Focused Document Management System.',
    category: 'office', category_name: '办公协同', aliases: ['文件标签', '资源管理', 'file tagging'],
    version: 'v9.5.4', license: 'GPL-3.0', homepage: 'https://docs.tagstud.io', stars: 4300, forks: 280,
    icon: 'https://raw.githubusercontent.com/TagStudioDev/TagStudio/main/src/tagstudio/resources/icon.png',
    icon_bg: 'linear-gradient(135deg, #10b981, #047857)', platforms: ['windows', 'macos', 'linux'],
    identifiers: { windows: ['TagStudio.exe'], macos: ['TagStudio.app'], linux: ['tagstudio'] },
    status: 'collected', daysAgo: 12,
  },
  {
    owner: 'lencx', repo: 'Noi', name: 'Noi',
    description: '把多个 AI 网页聚合到一个窗口里的桌面浏览器，支持自定义提示词与扩展。',
    description_en: 'An AI-enhanced, customizable browser designed to streamline your digital experience.',
    category: 'network', category_name: '网络工具', aliases: ['ai 浏览器', '聚合', 'chatgpt'],
    version: 'v0.4.0', license: 'MIT', homepage: 'https://noi.nofwl.com', stars: 6200, forks: 520,
    icon: 'https://raw.githubusercontent.com/lencx/Noi/main/website/static/readme/noi.png',
    icon_bg: 'linear-gradient(135deg, #6366f1, #4338ca)', platforms: ['windows', 'macos', 'linux'],
    identifiers: { windows: ['Noi.exe'], macos: ['Noi.app'], linux: ['noi'] },
    status: 'submitted', daysAgo: 20,
  },
  {
    owner: 'ente-io', repo: 'ente', name: 'Ente Photos',
    description: '端到端加密的开源相册，支持多端同步与自托管。',
    description_en: 'Fully open source, End to End Encrypted alternative to Google Photos and Apple Photos.',
    category: 'graphics', category_name: '图形创作', aliases: ['相册', '加密', 'google photos'],
    version: 'photos-v1.8.1', license: 'AGPL-3.0', homepage: 'https://ente.io', stars: 24000, forks: 1100,
    icon: 'https://cdn.simpleicons.org/ente',
    icon_bg: 'linear-gradient(135deg, #22c55e, #15803d)', platforms: ['windows', 'macos', 'linux', 'android', 'ios'],
    identifiers: { windows: ['ente.exe'], macos: ['ente.app'], linux: ['ente'], android: ['io.ente.photos'], ios: ['io.ente.photos'] },
    status: 'submitted', daysAgo: 31,
  },
  {
    // 已被官方目录收录（catalog.json 同 id）后转为归档记录
    owner: 'jellyfin', repo: 'jellyfin-desktop', name: 'Jellyfin Media Player',
    description: 'Jellyfin 媒体服务器的桌面客户端。',
    description_en: 'Desktop client for the Jellyfin media server.',
    category: 'media', category_name: '影音播放', aliases: ['jellyfin', '媒体服务器'],
    version: 'v1.12.0', license: 'GPL-2.0', homepage: 'https://jellyfin.org', stars: 3000, forks: 200,
    icon: 'https://cdn.simpleicons.org/jellyfin',
    icon_bg: 'linear-gradient(135deg, #a855f7, #7e22ce)', platforms: ['windows', 'macos', 'linux'],
    identifiers: { windows: ['jellyfin.exe'], macos: ['Jellyfin.app'], linux: ['jellyfin-desktop'] },
    status: 'submitted', archived: true, daysAgo: 60,
  },
];

/** 已提交行的 `pr_url`：指向清单仓库里按该应用 id 检索的 Issue 列表（演示站没有真实 Issue 编号）。 */
function seedSubmittedIssueUrl(id: string): string {
  return `${CATALOG_REPO_ISSUES}?q=${encodeURIComponent(`is:issue ${id}`)}`;
}

function customAppToEntry(r: SeedCustomApp, now: number): DraftEntryWire {
  const created = now - r.daysAgo * DAY_SECS;
  const item: DraftItemWire = {
    id: `${r.owner}/${r.repo}`.toLowerCase(),
    name: r.name,
    owner: r.owner,
    repo: r.repo,
    icon: r.icon,
    icon_bg: r.icon_bg,
    description: r.description,
    description_en: r.description_en,
    category: r.category,
    category_name: r.category_name,
    aliases: r.aliases,
    default_version: r.version,
    license: r.license,
    stars: r.stars,
    forks: r.forks,
    is_verified: false,
    homepage: r.homepage,
    install_dirs: [],
    search_subdirs: [],
    publishers: [],
    platforms: r.platforms,
    identifiers: r.identifiers,
  };
  return {
    id: item.id,
    item,
    status: r.status,
    pr_url: r.status === 'submitted' ? seedSubmittedIssueUrl(item.id) : null,
    created_at: created,
    updated_at: created + 3600,
    archived: r.archived === true,
  };
}

export function buildSeedCustomApps(now: number): DraftEntryWire[] {
  return SEED_CUSTOM_APPS.map((r) => customAppToEntry(r, now));
}

/** 种子引用的全部目录应用 id（供测试校验种子与 catalog.json 一致）。 */
export const SEED_CATALOG_REFS: readonly string[] = [
  ...SEED_INSTALLS.map((s) => s.id),
  ...SEED_FAVORITES,
  ...SEED_WATCHED,
  ...SEED_RECENT_VIEWS,
  ...SEED_WATCH_PENDING,
  ...SEED_WATCH_DISMISSED,
];
