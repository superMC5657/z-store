import { useEffect, useState } from 'react';
import { AppSettings } from './types';
import { api, DEFAULT_SETTINGS } from './services/api';
import i18n, { getSystemLanguage } from './i18n';
import { appZoomFactor, fontScaleFor } from './utils/density';

/**
 * 应用级外观表现与持久化设置 Hook。
 * 纯粹提取原 App.tsx 内联的主题/设置状态、字号/缩放应用逻辑、
 * 持久化快照合并、系统主题跟随以及通用设置更新器。无任何行为变更。
 */
export function useAppSettings() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const applyFontSize = (sizeKey: string) => {
    document.documentElement.setAttribute('data-font-size', sizeKey);
    document.documentElement.style.setProperty('--font-scale', fontScaleFor(sizeKey));
  };

  const applyUiZoom = (scaleStr: string) => {
    // --app-zoom var only; never root zoom nor native zoom.
    const factor = appZoomFactor(scaleStr);
    if (factor === null) return;
    document.documentElement.style.setProperty('--app-zoom', `${factor}`);
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
    if (!merged.download_dir) {
      merged.download_dir = DEFAULT_SETTINGS.download_dir;
    }
    if (!persisted.language) {
      merged.language = getSystemLanguage();
    }
    setSettings(merged);
    void i18n.changeLanguage(merged.language);

    // 应用主题
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

    // 应用字号
    applyFontSize(merged.font_size);

    // 应用界面缩放
    applyUiZoom(merged.ui_scale);

    if (merged.active_mirror) {
      api.switchMirror(merged.active_mirror);
    }
  };

  // 根据系统色彩偏好初始化主题（随后由 App 初始加载获取的持久化快照覆盖）
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

  // 主题快速切换器
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

  // 通用单项设置更新器
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
    } else if (key === 'language') {
      void i18n.changeLanguage(String(value));
    }
  };

  const handleToggleLanguage = () => {
    const nextLang = settings.language === 'zh-CN' ? 'en-US' : 'zh-CN';
    void handleUpdateSetting('language', nextLang);
  };

  return {
    theme,
    settings,
    applyPersistedSettings,
    handleToggleTheme,
    handleSetTheme,
    handleToggleLanguage,
    handleUpdateSetting,
  };
}
