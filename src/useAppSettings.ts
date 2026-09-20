import { useEffect, useState } from 'react';
import { AppSettings } from './types';
import { api, DEFAULT_SETTINGS } from './services/api';

/**
 * App-level appearance + persisted-settings concern.
 * Pure move of the theme/settings state, font-size/zoom appliers,
 * persisted-snapshot merge, system-theme follower and the generic
 * setting updater previously inline in App.tsx. No behavior change.
 */
export function useAppSettings() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const FONT_SCALE_MAP: Record<string, string> = {
    '12': '0.86',
    '14': '1',
    '16': '1.14',
    '18': '1.28',
    '20': '1.43',
    small: '0.86',
    standard: '1',
    medium: '1.14',
    large: '1.28',
  };

  const applyFontSize = (sizeKey: string) => {
    document.documentElement.setAttribute('data-font-size', sizeKey);
    const scale = FONT_SCALE_MAP[sizeKey] || '1';
    document.documentElement.style.setProperty('--font-scale', scale);
  };

  const applyUiZoom = (scaleStr: string) => {
    const factor = Number(scaleStr) / 100;
    document.documentElement.style.zoom = `${factor}`;
    document.documentElement.style.setProperty('--app-zoom', `${factor}`);

    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(factor))
      .catch(() => {});
  };

  // 将持久化设置快照合并入 AppSettings 并应用主题 / 字号 / 缩放（导入备份后复用同一路径）
  const applyPersistedSettings = (persisted: Record<string, string>) => {
    const merged: AppSettings = { ...DEFAULT_SETTINGS };
    for (const [k, v] of Object.entries(persisted)) {
      if (k in merged) {
        if (typeof (DEFAULT_SETTINGS as any)[k] === 'boolean') {
          (merged as any)[k] = v === 'true';
        } else if (typeof (DEFAULT_SETTINGS as any)[k] === 'number') {
          (merged as any)[k] = Number(v) || (DEFAULT_SETTINGS as any)[k];
        } else {
          (merged as any)[k] = v;
        }
      }
    }
    if (!merged.download_dir || merged.download_dir.includes('zstore_downloads')) {
      merged.download_dir = DEFAULT_SETTINGS.download_dir;
    }
    setSettings(merged);

    // Apply theme
    let currentTheme: 'light' | 'dark' = 'dark';
    if (merged.theme === 'light') {
      currentTheme = 'light';
    } else if (merged.theme === 'dark') {
      currentTheme = 'dark';
    } else {
      const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      currentTheme = isDark ? 'dark' : 'light';
    }
    setTheme(currentTheme);
    document.documentElement.setAttribute('data-theme', currentTheme);

    // Apply font size
    applyFontSize(merged.font_size);

    // Apply UI zoom
    applyUiZoom(merged.ui_scale);

    if (merged.active_mirror) {
      api.switchMirror(merged.active_mirror);
    }
  };

  // Initial theme from the system preference (the persisted snapshot
  // loaded by App's initial fetch overrides it when it lands).
  useEffect(() => {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = isDark ? 'dark' : 'light';
    setTheme(initialTheme);
    document.documentElement.setAttribute('data-theme', initialTheme);
  }, []);

  // 跟随系统主题动态监听
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      if (settings.theme === 'system') {
        const nextTheme = e.matches ? 'dark' : 'light';
        setTheme(nextTheme);
        document.documentElement.setAttribute('data-theme', nextTheme);
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [settings.theme]);

  // Theme Toggler
  const handleToggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    handleUpdateSetting('theme', next);
  };

  const handleSetTheme = (t: 'light' | 'dark' | 'system') => {
    let effective: 'light' | 'dark' = 'dark';
    if (t === 'light') {
      effective = 'light';
    } else if (t === 'dark') {
      effective = 'dark';
    } else {
      const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      effective = isDark ? 'dark' : 'light';
    }
    setTheme(effective);
    document.documentElement.setAttribute('data-theme', effective);
    handleUpdateSetting('theme', t);
  };

  // Generic Setting Updater
  const handleUpdateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    await api.saveSetting(key, String(value));

    if (key === 'theme') {
      const t = value as 'light' | 'dark' | 'system';
      let effective: 'light' | 'dark' = 'dark';
      if (t === 'light') {
        effective = 'light';
      } else if (t === 'dark') {
        effective = 'dark';
      } else {
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        effective = isDark ? 'dark' : 'light';
      }
      setTheme(effective);
      document.documentElement.setAttribute('data-theme', effective);
    } else if (key === 'font_size') {
      applyFontSize(String(value));
    } else if (key === 'ui_scale') {
      applyUiZoom(String(value));
    }
  };

  // Reset all settings to factory default
  const handleResetSettings = async () => {
    await api.resetSettings();
    setSettings(DEFAULT_SETTINGS);
    setTheme('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    applyFontSize('14');
    applyUiZoom('100');
  };

  return {
    theme,
    settings,
    applyPersistedSettings,
    handleToggleTheme,
    handleSetTheme,
    handleUpdateSetting,
    handleResetSettings,
  };
}
