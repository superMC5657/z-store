import { useEffect, useState } from 'react';
import { AppSettings } from './types';
import { tauriApi, DEFAULT_SETTINGS } from './services/api';
import i18n, { getSystemLanguage } from './i18n';
import { appZoomFactor, fontScaleFor } from './utils/density';
import { notifyToast } from './utils/notify';

/** ADR-0007：TTL 有效挡位（分钟），与后端 `DETAIL_CACHE_TTL_VALID_MINUTES` 同口径；0=每次实时校验。 */
const DETAIL_CACHE_TTL_VALID_MINUTES = [0, 10, 60, 360, 1440];

/**
 * 后端 `normalize_setting_value` 的前端同口径镜像：仅镜像 AppSettings 实际持有
 * 且后端写入侧会归一化的键（TTL 挡位 / 通知频率），其余键后端原样透传。
 * `save_setting` 只回 bool，持久化成功后以此回写 state，保证展示值与落库值一致。
 */
function normalizeSettingLikeBackend<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): AppSettings[K] {
  if (key === 'detail_cache_ttl_minutes') {
    const n = Number(value);
    return (
      DETAIL_CACHE_TTL_VALID_MINUTES.includes(n)
        ? n
        : DEFAULT_SETTINGS.detail_cache_ttl_minutes
    ) as AppSettings[K];
  }
  if (key === 'watch_notify_frequency') {
    return (
      value === 'startup' || value === 'daily' ? value : DEFAULT_SETTINGS.watch_notify_frequency
    ) as AppSettings[K];
  }
  return value;
}

/**
 * 应用级外观表现与持久化设置 Hook：主题/设置状态、字号/缩放应用、
 * 持久化快照合并、系统主题跟随与通用设置更新器。
 */
export function useAppSettings() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const applyFontSize = (sizeKey: string) => {
    document.documentElement.setAttribute('data-font-size', sizeKey);
    document.documentElement.style.setProperty('--font-scale', fontScaleFor(sizeKey));
  };

  const applyUiZoom = (scaleStr: string) => {
    // 仅设置 --app-zoom 变量；绝不修改根节点缩放或原生缩放。
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
          // 显式判空：`0` 是合法挡位（TTL 实时校验档），不得被 truthy 兜底吞掉；
          // 非数字串（NaN）仍回默认，与旧口径的垃圾值防护一致。
          const n = Number(v);
          (merged as any)[k] =
            v === '' || v == null || !Number.isFinite(n) ? (DEFAULT_SETTINGS as any)[k] : n;
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
      // 启动回放镜像档位：历史存量值若不满足新准入口径（https 强制 + 域名校验）
      // 会被后端拒绝并保持直连（fail-closed，后端镜像初始态即 direct），
      // 不打断启动；失败/拒绝后同步回滚 state 到 direct，并提示避免 UI 与后端分叉。
      tauriApi
        .switchMirror(merged.active_mirror)
        .then((ok) => {
          if (ok) return;
          setSettings((prev) => ({ ...prev, active_mirror: 'direct' }));
          notifyToast(i18n.t('settings.mirror_replay_failed', { error: i18n.t('settings.mirror_replay_rejected') }), 'warning');
        })
        .catch((e) => {
          setSettings((prev) => ({ ...prev, active_mirror: 'direct' }));
          notifyToast(i18n.t('settings.mirror_replay_failed', { error: String(e) }), 'warning');
        });
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

  // 通用单项设置更新器：乐观更新 → 持久化（失败回滚乐观值并提示）→
  // 成功后按后端归一口径回写（save_setting 只回 bool，钳制镜像见 normalizeSettingLikeBackend）
  const handleUpdateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      await tauriApi.saveSetting(key, String(value));
    } catch (e) {
      setSettings((prev) => ({ ...prev, [key]: settings[key] }));
      notifyToast(i18n.t('settings.persist_failed', { error: String(e) }), 'error');
      return;
    }
    const normalized = normalizeSettingLikeBackend(key, value);
    if (normalized !== value) {
      setSettings((prev) => ({ ...prev, [key]: normalized }));
    }

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
