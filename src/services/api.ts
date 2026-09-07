import {
  AppDetail,
  AppMatchResult,
  AppSettings,
  AppSummary,
  DownloadProgressPayload,
  ImportAppRequest,
  InstalledApp,
  MirrorNodeStatus,
  ProxyTestResult,
  SignatureInfo,
  StarredSyncResult,
  UpdateItem,
  UpdateRule,
  DeveloperProfile,
  HostTokenEntry,
  HostRateLimitStatus,
  DeepLinkAction,
  SyncCatalogResult,
  ForgeRepoInfo,
  QuotaUpdatePayload,
} from '../types';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  ui_scale: '100',
  font_size: '14',
  portable_dir: '%LOCALAPPDATA%\\Programs\\z-store-apps',
  download_dir: '%TEMP%\\zstore_downloads',
  active_mirror: 'ghproxy',
  max_concurrent_downloads: 3,
  github_token: '',
  close_to_tray: true,
  launch_on_startup: false,
  update_frequency: 'startup',
  detail_cache_ttl_minutes: 30,
  catalog_source_url: 'https://gh-proxy.com/https://raw.githubusercontent.com/supermc/z-store/main/src-tauri/src/catalog.json',
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
    icon: 'https://github.com/rustdesk.png',
    icon_bg: 'linear-gradient(135deg, #f97316, #ea580c)',
    description: '开箱即用的开源远程桌面客户端与服务端软件，采用 Rust 编写，具备端到端加密、高帧率低延迟。',
    stars: 76800,
    forks: 10200,
    license: 'AGPL-3.0',
    latest_version: 'v1.3.1',
    changelog: '优化网络握手，提升中继转发性能，优化多屏高 DPI 鼠标映射与剪贴板同步。',
    is_verified: true,
    signature_fingerprint: '57:B6:08:5F:D9:58:23:77:13:C2:13:79:2F:94:AE:CE:62:B1:5C:51:94:C8:A1:A2:B6:A4:9A:B9:C2:CB:32:8A',
    readme_markdown: '# RustDesk\n\n开源远程桌面解决方案，替代 TeamViewer 与 AnyDesk。支持自主部署 Rendezvous / Relay 协调服务器。',
    category: 'system',
    category_name: '系统实用',
    homepage: 'https://rustdesk.com',
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
    icon: 'https://github.com/localsend.png',
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
    homepage: 'https://localsend.org',
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
    icon: 'https://github.com/videolan.png',
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
  { id: 'ghproxy', name: 'GH-Proxy 加速线路 (主流推荐)', base_url: 'https://gh-proxy.com', latency_ms: 68, is_active: true },
  { id: 'ghproxynet', name: 'GHProxy.net 备用线路 (华东/华北)', base_url: 'https://ghproxy.net', latency_ms: 88, is_active: false },
  { id: 'ghfast', name: 'GHFast 高速线路 (电信/联通优选)', base_url: 'https://ghfast.top', latency_ms: 95, is_active: false },
  { id: 'direct', name: 'GitHub 官方直连 (海外/科学上网)', base_url: 'https://github.com', latency_ms: 240, is_active: false },
];

let mockRules: UpdateRule[] = [];

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

  async getAppDetails(id: string, forceRefresh = false): Promise<AppDetail> {
    if (isTauri) {
      const res = await tauriInvoke<AppDetail>('get_app_details', {
        id,
        forceRefresh,
        force_refresh: forceRefresh,
      });
      if (res) {
        res.releases = Array.isArray(res.releases)
          ? res.releases
          : Array.isArray(res.assets)
          ? res.assets
          : [];
      }
      return res;
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

  async forceRefreshApp(id: string): Promise<AppDetail> {
    return this.getAppDetails(id, true);
  },

  async getInstalledApps(): Promise<InstalledApp[]> {
    if (isTauri) {
      return tauriInvoke<InstalledApp[]>('get_installed_apps');
    }
    return [...mockInstalled];
  },

  async installApp(appId: string, assetName?: string, customInstallDir?: string): Promise<InstalledApp> {
    if (isTauri) {
      return tauriInvoke<InstalledApp>('install_app', {
        appId,
        assetName: assetName || null,
        customInstallDir: customInstallDir || null,
      });
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

  async unmanageApp(appId: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('unmanage_app', { appId });
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

  async checkForUpdates(forceRefresh = false): Promise<UpdateItem[]> {
    if (isTauri) {
      return tauriInvoke<UpdateItem[]>('check_for_updates', { forceRefresh });
    }
    const updates: UpdateItem[] = [];
    for (const app of mockInstalled) {
      const detail = MOCK_APPS[app.app_id];
      if (detail && detail.latest_version !== app.version) {
        const rule = mockRules.find((r) => r.app_id.toLowerCase() === app.app_id.toLowerCase());
        if (rule) {
          if (rule.is_frozen || rule.is_hidden) continue;
          if (rule.skipped_version && rule.skipped_version.replace(/^v/, '') === detail.latest_version.replace(/^v/, '')) {
            continue;
          }
        }
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

  async testProxy(proxyUrl?: string): Promise<ProxyTestResult> {
    if (isTauri) {
      return tauriInvoke<ProxyTestResult>('test_proxy', { proxyUrl: proxyUrl || null });
    }
    return {
      success: true,
      latency_ms: proxyUrl ? 320 : 180,
      message: '320 ms (连接正常)',
    };
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

  async warmupTopApps(limit = 15): Promise<number> {
    if (isTauri) {
      return tauriInvoke<number>('warmup_top_apps', { limit });
    }
    return 0;
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

  async getDetectedInstalledAppIds(forceRefresh = false): Promise<string[]> {
    if (isTauri) {
      return tauriInvoke<string[]>('get_detected_installed_app_ids', { forceRefresh });
    }
    return ['oh-my-posh'];
  },

  async importSingleApp(appId: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('import_single_app', { appId });
    }
    return true;
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

  async getUpdateRules(): Promise<UpdateRule[]> {
    if (isTauri) {
      return tauriInvoke<UpdateRule[]>('get_update_rules');
    }
    return [...mockRules];
  },

  async setAppSkipVersion(appId: string, version: string | null): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('set_app_skip_version', { appId, version });
    }
    const idx = mockRules.findIndex((r) => r.app_id === appId);
    if (idx >= 0) {
      mockRules[idx].skipped_version = version;
      mockRules[idx].updated_at = Date.now();
    } else {
      mockRules.push({
        app_id: appId,
        skipped_version: version,
        is_frozen: false,
        is_hidden: false,
        updated_at: Date.now(),
      });
    }
    return true;
  },

  async setAppFrozen(appId: string, isFrozen: boolean): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('set_app_frozen', { appId, isFrozen });
    }
    const idx = mockRules.findIndex((r) => r.app_id === appId);
    if (idx >= 0) {
      mockRules[idx].is_frozen = isFrozen;
      mockRules[idx].updated_at = Date.now();
    } else {
      mockRules.push({
        app_id: appId,
        is_frozen: isFrozen,
        is_hidden: false,
        updated_at: Date.now(),
      });
    }
    return true;
  },

  async setAppHidden(appId: string, isHidden: boolean): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('set_app_hidden', { appId, isHidden });
    }
    const idx = mockRules.findIndex((r) => r.app_id === appId);
    if (idx >= 0) {
      mockRules[idx].is_hidden = isHidden;
      mockRules[idx].updated_at = Date.now();
    } else {
      mockRules.push({
        app_id: appId,
        is_frozen: false,
        is_hidden: isHidden,
        updated_at: Date.now(),
      });
    }
    return true;
  },

  async removeUpdateRule(appId: string): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('remove_update_rule', { appId });
    }
    mockRules = mockRules.filter((r) => r.app_id !== appId);
    return true;
  },

  async verifyFileSignature(filePath: string): Promise<SignatureInfo> {
    if (isTauri) {
      return tauriInvoke<SignatureInfo>('verify_file_signature', { filePath });
    }
    return {
      is_signed: true,
      is_valid: true,
      status: 'Valid',
      status_message: 'Mock signature verified',
      subject: 'CN=Open Source Publisher',
      issuer: 'CN=DigiCert Trusted Root G4',
      serial_number: '1234567890ABCDEF',
      thumbprint_sha1: '3B77DB29AC72AA6B5880ECB2ED5EC1EC6601D847',
      thumbprint_sha256: '57:B6:08:5F:D9:58:23:77:13:C2:13:79:2F:94:AE:CE:62:B1:5C:51:94:C8:A1:A2:B6:A4:9A:B9:C2:CB:32:8A',
    };
  },

  async getDeveloperProfile(developer: string): Promise<DeveloperProfile> {
    if (isTauri) {
      return tauriInvoke<DeveloperProfile>('get_developer_profile', { developer });
    }
    await new Promise((r) => setTimeout(r, 250));
    const devLower = developer.toLowerCase();
    const matchedApps = Object.values(MOCK_APPS).filter((a) => a.owner.toLowerCase() === devLower);
    return {
      login: developer,
      name: developer === 'localsend' ? 'LocalSend Team' : developer === 'obsproject' ? 'OBS Project' : developer,
      avatar_url: `https://avatars.githubusercontent.com/${developer}`,
      html_url: `https://github.com/${developer}`,
      bio: `致力于打造优质、安全且自由的开源生产力软件工具 · GitHub 开源组织`,
      company: `@${developer}`,
      blog: `https://${developer}.org`,
      location: 'Global / Open Source',
      public_repos: Math.max(matchedApps.length, 6),
      followers: 3200,
      following: 12,
      repos: matchedApps.map((a) => ({
        id: a.id,
        name: a.name,
        full_name: `${a.owner}/${a.repo}`,
        description: a.description,
        html_url: `https://github.com/${a.owner}/${a.repo}`,
        stars: a.stars,
        forks: a.forks,
        language: 'Rust / TypeScript / C++',
        has_releases: true,
        in_catalog: true,
        latest_release_tag: a.latest_version,
      })),
    };
  },

  async syncGithubStarred(username?: string): Promise<StarredSyncResult> {
    if (isTauri) {
      return tauriInvoke<StarredSyncResult>('sync_github_starred', { username });
    }
    await new Promise((r) => setTimeout(r, 400));
    const cleanUser = username?.trim().toLowerCase();
    const matches = cleanUser === 'demo' ? Object.values(MOCK_APPS).slice(0, 2).map((d) => ({
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
    })) : [];
    return {
      total_starred: matches.length,
      catalog_matches: matches,
      other_repos: [],
    };
  },

  async recordSearchQuery(query: string): Promise<void> {
    if (isTauri) {
      return tauriInvoke<void>('record_search_query', { query });
    }
    const q = query.trim();
    if (!q) return;
    mockSearchHistory = [q, ...mockSearchHistory.filter((x) => x !== q)].slice(0, 20);
  },

  async getSearchHistory(): Promise<string[]> {
    if (isTauri) {
      return tauriInvoke<string[]>('get_search_history');
    }
    return [...mockSearchHistory];
  },

  async clearSearchHistory(): Promise<void> {
    if (isTauri) {
      return tauriInvoke<void>('clear_search_history');
    }
    mockSearchHistory = [];
  },

  async removeSearchQuery(query: string): Promise<void> {
    if (isTauri) {
      return tauriInvoke<void>('remove_search_query', { query });
    }
    mockSearchHistory = mockSearchHistory.filter((x) => x !== query);
  },

  async recordAppView(appId: string): Promise<void> {
    if (isTauri) {
      return tauriInvoke<void>('record_app_view', { appId });
    }
    const id = appId.trim();
    if (!id) return;
    mockViewHistory = [id, ...mockViewHistory.filter((x) => x !== id)].slice(0, 30);
  },

  async getRecentlyViewedApps(): Promise<AppSummary[]> {
    if (isTauri) {
      return tauriInvoke<AppSummary[]>('get_recently_viewed_apps');
    }
    return mockViewHistory
      .map((id) => {
        const d = MOCK_APPS[id];
        if (!d) return null;
        return {
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
        };
      })
      .filter((a): a is AppSummary => a !== null);
  },

  async clearViewHistory(): Promise<void> {
    if (isTauri) {
      return tauriInvoke<void>('clear_view_history');
    }
    mockViewHistory = [];
  },

  async getHostTokens(): Promise<HostTokenEntry[]> {
    if (isTauri) {
      return tauriInvoke<HostTokenEntry[]>('get_host_tokens');
    }
    return mockHostTokens;
  },

  async setHostToken(host: string, token: string): Promise<void> {
    if (isTauri) {
      return tauriInvoke<void>('set_host_token', { host, token });
    }
    const idx = mockHostTokens.findIndex((t) => t.host.toLowerCase() === host.toLowerCase());
    const entry: HostTokenEntry = {
      host: host.toLowerCase(),
      token,
      rate_limit_remaining: 4980,
      rate_limit_limit: 5000,
      rate_limit_reset: Math.floor(Date.now() / 1000) + 3600,
      updated_at: Math.floor(Date.now() / 1000),
    };
    if (idx >= 0) {
      mockHostTokens[idx] = entry;
    } else {
      mockHostTokens.push(entry);
    }
  },

  async removeHostToken(host: string): Promise<void> {
    if (isTauri) {
      return tauriInvoke<void>('remove_host_token', { host });
    }
    mockHostTokens = mockHostTokens.filter((t) => t.host.toLowerCase() !== host.toLowerCase());
  },

  async onQuotaUpdated(callback: (payload: QuotaUpdatePayload) => void): Promise<() => void> {
    if (isTauri) {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<QuotaUpdatePayload>('zstore://quota-updated', (e) => {
        callback(e.payload);
      });
    }
    return () => {};
  },

  async refreshHostRateLimit(host?: string): Promise<HostTokenEntry> {
    if (isTauri) {
      return tauriInvoke<HostTokenEntry>('refresh_host_rate_limit', { host });
    }
    return {
      host: host || 'github.com',
      token: '',
      rate_limit_remaining: 60,
      rate_limit_limit: 60,
      updated_at: Math.floor(Date.now() / 1000),
    };
  },

  async testHostConnection(host: string, token?: string): Promise<HostRateLimitStatus> {
    if (isTauri) {
      return tauriInvoke<HostRateLimitStatus>('test_host_connection', { host, token });
    }
    return {
      host,
      is_connected: true,
      rate_limit_remaining: token ? 4995 : 60,
      rate_limit_limit: token ? 5000 : 60,
      message: token ? 'API 令牌认证有效，配额充裕' : '免鉴权连接成功（配额受限）',
    };
  },

  async registerDeepLinkScheme(): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('register_deep_link_scheme');
    }
    return true;
  },

  async handleDeepLink(url: string): Promise<DeepLinkAction> {
    if (isTauri) {
      return tauriInvoke<DeepLinkAction>('handle_deep_link', { url });
    }
    // Mock parser
    const clean = url.replace(/^zstore:\/\//, '').replace(/^\//, '');
    if (clean.startsWith('app/')) {
      return { action: 'app_detail', payload: { app_id: clean.slice(4) } };
    }
    if (clean.startsWith('install/')) {
      return { action: 'install_app', payload: { app_id: clean.slice(8) } };
    }
    if (clean.startsWith('search')) {
      const q = new URLSearchParams(clean.split('?')[1] || '').get('q') || '';
      return { action: 'search', payload: { query: q } };
    }
    if (clean.startsWith('developer/')) {
      return { action: 'developer_profile', payload: { owner: clean.slice(10) } };
    }
    return { action: 'app_detail', payload: { app_id: clean } };
  },

  async getCliDeepLink(): Promise<string | null> {
    if (isTauri) {
      return tauriInvoke<string | null>('get_cli_deep_link');
    }
    return null;
  },

  async searchForgeRepos(forge: string, query: string, host?: string): Promise<ForgeRepoInfo[]> {
    if (isTauri) {
      return tauriInvoke<ForgeRepoInfo[]>('search_forge_repos', { forge, host, query });
    }
    return [];
  },

  async syncCatalog(force?: boolean): Promise<SyncCatalogResult> {
    if (isTauri) {
      return tauriInvoke<SyncCatalogResult>('sync_catalog', { force });
    }
    return {
      updated: false,
      count: 32,
      message: '浏览器预览模式：当前使用内置离线种子 (32 个应用)',
    };
  },

  async selectFolder(defaultPath?: string): Promise<string | null> {
    if (isTauri) {
      return tauriInvoke<string | null>('select_folder', { defaultPath });
    }
    return 'D:\\ZStoreApps';
  },

  async getOrFetchIcon(
    owner: string | undefined,
    repo: string | undefined,
    appId: string | undefined,
    remoteUrl: string
  ): Promise<string> {
    if (isTauri) {
      return tauriInvoke<string>('get_or_fetch_icon', { owner, repo, appId, remoteUrl });
    }
    return remoteUrl;
  },

  async openUrl(url: string): Promise<void> {
    if (!url) return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    if (isTauri) {
      try {
        await tauriInvoke('open_url', { url: trimmed });
        return;
      } catch (err) {
        console.warn('Failed to invoke open_url via Tauri, falling back to window.open:', err);
      }
    }
    window.open(trimmed, '_blank', 'noopener,noreferrer');
  },
};

let mockSearchHistory: string[] = ['RustDesk', 'LocalSend', 'OBS Studio', 'VLC'];
let mockViewHistory: string[] = ['rustdesk', 'localsend', 'obs-studio'];
let mockHostTokens: HostTokenEntry[] = [
  {
    host: 'github.com',
    token: 'ghp_mocktoken123456789',
    rate_limit_remaining: 4985,
    rate_limit_limit: 5000,
    rate_limit_reset: Math.floor(Date.now() / 1000) + 3600,
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    host: 'codeberg.org',
    token: '',
    rate_limit_remaining: 3000,
    rate_limit_limit: 3000,
    rate_limit_reset: undefined,
    updated_at: Math.floor(Date.now() / 1000),
  },
];
