import {
  AppDetail,
  AppMatchResult,
  AppSettings,
  AppSummary,
  DownloadProgressPayload,
  ImportAppRequest,
  InstalledApp,
  MirrorNodeStatus,
  UpdateItem,
} from '../types';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  ui_scale: '100',
  font_size: 'standard',
  always_on_top: false,
  portable_dir: '%LOCALAPPDATA%\\Programs\\z-store-apps',
  download_dir: '%TEMP%\\zstore_downloads',
  auto_clean_cache: true,
  active_mirror: 'ghproxy',
  max_concurrent_downloads: 3,
  github_token: '',
  close_to_tray: true,
  launch_on_startup: false,
  update_frequency: 'startup',
};

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  throw new Error('Not in Tauri environment');
}

// 浏览器独立预览模式下的 Mock 数据
const MOCK_APPS: Record<string, AppDetail> = {
  rustdesk: {
    id: 'rustdesk',
    name: 'RustDesk',
    owner: 'rustdesk',
    repo: 'rustdesk',
    icon: '🦀',
    icon_bg: 'linear-gradient(135deg, #f97316, #ea580c)',
    description: '开箱即用的开源远程桌面客户端与服务端软件，采用 Rust 编写，具备端到端加密、高帧率低延迟。',
    stars: 76800,
    forks: 10200,
    license: 'AGPL-3.0',
    latest_version: 'v1.3.1',
    changelog: '优化网络握手，提升中继转发性能，优化多屏高 DPI 鼠标映射与剪贴板同步。',
    is_verified: true,
    signature_fingerprint: 'E8:7A:B4:9C:12:34:56:78',
    readme_markdown: '# RustDesk\n\n开源远程桌面解决方案，替代 TeamViewer 与 AnyDesk。支持自主部署 Rendezvous / Relay 协调服务器。',
    category: 'system',
    category_name: '系统实用',
    releases: [
      {
        name: 'rustdesk-1.3.1-x86_64.msi',
        download_url: 'https://github.com/rustdesk/rustdesk/releases/download/1.3.1/rustdesk-1.3.1-x86_64.msi',
        size_bytes: 20293798,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        os: 'windows',
        arch: 'x86_64',
        kind: 'msi',
      },
      {
        name: 'rustdesk-1.3.1-portable.zip',
        download_url: 'https://github.com/rustdesk/rustdesk/releases/download/1.3.1/rustdesk-1.3.1-portable.zip',
        size_bytes: 18451200,
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        os: 'windows',
        arch: 'x86_64',
        kind: 'portable_zip',
      },
    ],
  },
  localsend: {
    id: 'localsend',
    name: 'LocalSend',
    owner: 'localsend',
    repo: 'localsend',
    icon: '🚀',
    icon_bg: 'linear-gradient(135deg, #0284c7, #0369a1)',
    description: '跨平台的开源局域网文件传输工具，无需互联网，基于安全协议高速传输。',
    stars: 49200,
    forks: 3200,
    license: 'Apache-2.0',
    latest_version: 'v1.14.0',
    changelog: '新增深色模式适配，优化 Windows 网络唤醒发现速度。',
    is_verified: true,
    signature_fingerprint: '3F:92:D1:6A:77:88:99:AA',
    readme_markdown: '# LocalSend\n\n开源隔空投送 (AirDrop) 替代工具，支持 Windows, macOS, Linux, Android 与 iOS。',
    category: 'network',
    category_name: '网络工具',
    releases: [
      {
        name: 'LocalSend-1.14.0-windows-x86-64.msi',
        download_url: 'https://github.com/localsend/localsend/releases/download/v1.14.0/LocalSend-1.14.0-windows-x86-64.msi',
        size_bytes: 38241000,
        sha256: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
        os: 'windows',
        arch: 'x86_64',
        kind: 'msi',
      },
    ],
  },
  vlc: {
    id: 'vlc',
    name: 'VLC Media Player',
    owner: 'videolan',
    repo: 'vlc',
    icon: '🎬',
    icon_bg: 'linear-gradient(135deg, #f59e0b, #d97706)',
    description: '支持所有音频和视频格式的跨平台多媒体播放器与流媒体服务器，开源无广告。',
    stars: 32000,
    forks: 5800,
    license: 'GPL-2.0',
    latest_version: '3.0.21',
    changelog: '更新解码库，修复高帧率 HDR 渲染内存泄漏，完善杜比视界支持。',
    is_verified: true,
    readme_markdown: '# VLC Media Player\n\n开源全格式音视频播放器基准。',
    category: 'media',
    category_name: '影音视听',
    releases: [
      {
        name: 'vlc-3.0.21-win64.msi',
        download_url: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.msi',
        size_bytes: 42100000,
        sha256: '3489fe7891234567890123456789abcdef0123456789abcdef0123456789abcd',
        os: 'windows',
        arch: 'x86_64',
        kind: 'msi',
      },
    ],
  },
};

let mockInstalled: InstalledApp[] = [
  {
    app_id: 'rustdesk',
    app_name: 'RustDesk',
    version: 'v1.2.6',
    installed_at: Date.now() - 86400000 * 3,
    install_method: 'msi',
    install_path: 'C:\\Program Files\\RustDesk\\rustdesk.exe',
    asset_name: 'rustdesk-1.2.6-x86_64.msi',
    asset_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
];

let mockMirrors: MirrorNodeStatus[] = [
  { id: 'ghproxy', name: 'GH-Proxy 加速线路 (华东/华南优质)', base_url: 'https://gh-proxy.com', latency_ms: 38, is_active: true },
  { id: 'gitmirror', name: 'GitMirror 备用线路 (华北/西北推荐)', base_url: 'https://hub.gitmirror.com', latency_ms: 68, is_active: false },
  { id: 'direct', name: 'GitHub 官方直连线路 (海外/科学上网)', base_url: 'https://github.com', latency_ms: 220, is_active: false },
];

let mockSettings: Record<string, string> = {
  theme: 'dark',
  active_mirror: 'ghproxy',
  github_token: '',
};

export const api = {
  async searchApps(query: string): Promise<AppSummary[]> {
    if (isTauri) {
      return tauriInvoke<AppSummary[]>('search_apps', { query });
    }
    const q = query.trim().toLowerCase();
    const all = Object.values(MOCK_APPS).map((d) => ({
      id: d.id,
      name: d.name,
      owner: d.owner,
      repo: d.repo,
      icon: d.icon,
      icon_bg: d.icon_bg,
      description: d.description,
      stars: d.stars,
      forks: d.forks,
      license: d.license,
      latest_version: d.latest_version,
      category: d.category,
      category_name: d.category_name,
      is_verified: d.is_verified,
      is_installed: mockInstalled.some((i) => i.app_id === d.id),
      has_update: mockInstalled.some((i) => i.app_id === d.id && i.version !== d.latest_version),
    }));

    if (!q) return all;
    return all.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        a.category_name.toLowerCase().includes(q)
    );
  },

  async getAppDetails(id: string): Promise<AppDetail> {
    if (isTauri) {
      return tauriInvoke<AppDetail>('get_app_details', { id });
    }
    if (MOCK_APPS[id]) return MOCK_APPS[id];
    return {
      id,
      name: id,
      owner: 'github',
      repo: id,
      icon: '📦',
      icon_bg: 'linear-gradient(135deg, #475569, #334155)',
      description: '开源软件应用',
      stars: 1200,
      forks: 180,
      license: 'MIT',
      latest_version: 'v1.0.0',
      changelog: '初版发布',
      is_verified: false,
      readme_markdown: `# ${id}\n\n该开源项目暂未配置本地扩展元数据。`,
      category: 'system',
      category_name: '系统实用',
      releases: [],
    };
  },

  async getInstalledApps(): Promise<InstalledApp[]> {
    if (isTauri) {
      return tauriInvoke<InstalledApp[]>('get_installed_apps');
    }
    return [...mockInstalled];
  },

  async installApp(appId: string): Promise<InstalledApp> {
    if (isTauri) {
      return tauriInvoke<InstalledApp>('install_app', { appId });
    }
    const detail = await api.getAppDetails(appId);
    const newApp: InstalledApp = {
      app_id: detail.id,
      app_name: detail.name,
      version: detail.latest_version,
      installed_at: Date.now(),
      install_method: 'msi',
      install_path: `C:\\Program Files\\${detail.name}\\${detail.id}.exe`,
      asset_name: `${detail.id}-setup.msi`,
      asset_sha256: 'verified-sha256-hash-ok',
      uninstall_command: 'msiexec /x',
    };
    mockInstalled = [...mockInstalled.filter((a) => a.app_id !== appId), newApp];
    return newApp;
  },

  async uninstallApp(appId: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('uninstall_app', { appId });
    }
    mockInstalled = mockInstalled.filter((a) => a.app_id !== appId);
    return true;
  },

  async launchApp(appId: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('launch_app', { appId });
    }
    await new Promise((r) => setTimeout(r, 200));
    return true;
  },

  async checkForUpdates(): Promise<UpdateItem[]> {
    if (isTauri) {
      return tauriInvoke<UpdateItem[]>('check_for_updates');
    }
    const updates: UpdateItem[] = [];
    for (const app of mockInstalled) {
      const detail = MOCK_APPS[app.app_id];
      if (detail && detail.latest_version !== app.version) {
        updates.push({
          app_id: app.app_id,
          app_name: app.app_name,
          current_version: app.version,
          latest_version: detail.latest_version,
          changelog: detail.changelog,
        });
      }
    }
    return updates;
  },

  async getMirrorStatus(): Promise<MirrorNodeStatus[]> {
    if (isTauri) {
      return tauriInvoke<MirrorNodeStatus[]>('get_mirror_status');
    }
    return [...mockMirrors];
  },

  async switchMirror(mirrorId: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('switch_mirror', { mirrorId });
    }
    mockMirrors = mockMirrors.map((m) => ({ ...m, is_active: m.id === mirrorId }));
    mockSettings.active_mirror = mirrorId;
    return true;
  },

  async pingMirrors(): Promise<MirrorNodeStatus[]> {
    if (isTauri) {
      return tauriInvoke<MirrorNodeStatus[]>('ping_mirrors');
    }
    mockMirrors = mockMirrors.map((m) => ({
      ...m,
      latency_ms: Math.floor(Math.random() * 80) + (m.id === 'direct' ? 180 : 30),
    }));
    return [...mockMirrors];
  },

  async setGithubToken(token: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('set_github_token', { token });
    }
    mockSettings.github_token = token;
    return true;
  },

  async getSettings(): Promise<Record<string, string>> {
    if (isTauri) {
      return tauriInvoke<Record<string, string>>('get_settings');
    }
    return { ...mockSettings };
  },

  async saveSetting(key: string, value: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('save_setting', { key, value });
    }
    mockSettings[key] = value;
    return true;
  },

  async resetSettings(): Promise<boolean> {
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
      await this.saveSetting(key, String(val));
    }
    mockSettings = Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, String(v)])
    );
    return true;
  },

  async getFavorites(): Promise<string[]> {
    if (isTauri) {
      return tauriInvoke<string[]>('get_favorites');
    }
    return ['rustdesk'];
  },

  async toggleFavorite(appId: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('toggle_favorite', { appId });
    }
    return true;
  },

  async clearCache(): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('clear_cache');
    }
    return true;
  },

  async getCategoryApps(category: string): Promise<AppSummary[]> {
    if (isTauri) {
      return tauriInvoke<AppSummary[]>('get_category_apps', { category });
    }
    return Object.values(MOCK_APPS)
      .filter((d) => d.category.toLowerCase() === category.toLowerCase())
      .map((d) => ({
        id: d.id,
        name: d.name,
        owner: d.owner,
        repo: d.repo,
        category: d.category,
        category_name: d.category_name,
        icon: d.icon,
        icon_bg: d.icon_bg,
        description: d.description,
        stars: d.stars,
        forks: d.forks,
        license: d.license,
        latest_version: d.latest_version,
        is_verified: d.is_verified,
      }));
  },

  async getCatalogCount(): Promise<number> {
    if (isTauri) {
      return tauriInvoke<number>('get_catalog_count');
    }
    return Object.keys(MOCK_APPS).length;
  },

  async scanAndMatchLocalApps(): Promise<AppMatchResult[]> {
    if (isTauri) {
      return tauriInvoke<AppMatchResult[]>('scan_and_match_local_apps');
    }
    await new Promise((r) => setTimeout(r, 600));
    return [
      {
        scanned: {
          display_name: 'VLC media player 3.0.21',
          display_version: '3.0.21',
          publisher: 'VideoLAN',
          install_location: 'C:\\Program Files\\VideoLAN\\VLC',
          display_icon: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
          uninstall_string: 'C:\\Program Files\\VideoLAN\\VLC\\uninstall.exe',
        },
        catalog_id: 'videolan/vlc',
        name: 'VLC Media Player',
        chinese_name: 'VLC 播放器',
        owner: 'videolan',
        repo: 'vlc',
        icon: 'vlc.svg',
        icon_bg: '#ff8800',
        description: '开源全能媒体播放器',
        local_version: '3.0.21',
        catalog_version: 'v3.0.21',
        confidence: 0.95,
        confidence_tier: 'high',
      },
      {
        scanned: {
          display_name: 'OBS Studio',
          display_version: '30.2.0',
          publisher: 'OBS Project',
          install_location: 'C:\\Program Files\\obs-studio',
          display_icon: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
        },
        catalog_id: 'obsproject/obs-studio',
        name: 'OBS Studio',
        chinese_name: 'OBS 直播录屏',
        owner: 'obsproject',
        repo: 'obs-studio',
        icon: 'obs.svg',
        icon_bg: '#302e31',
        description: '开源直播与录屏工具',
        local_version: '30.2.0',
        catalog_version: 'v31.0.1',
        confidence: 0.92,
        confidence_tier: 'high',
      },
    ];
  },

  async importMatchedApps(apps: ImportAppRequest[]): Promise<number> {
    if (isTauri) {
      return tauriInvoke<number>('import_matched_apps', { apps });
    }
    await new Promise((r) => setTimeout(r, 400));
    return apps.length;
  },

  async onDownloadProgress(callback: (payload: DownloadProgressPayload) => void): Promise<() => void> {
    if (isTauri) {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<DownloadProgressPayload>('zstore://download-progress', (e) => {
        callback(e.payload);
      });
      return unlisten;
    }
    return () => {};
  },
};
