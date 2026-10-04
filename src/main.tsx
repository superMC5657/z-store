import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import './styles/fluent.css';
import { initZLog } from './lib/z-log';

void initZLog();

async function bootstrap(): Promise<void> {
  // Live-demo embed (`/live-demo`): install the Tauri mock BEFORE any
  // `services/api` evaluation (so its `isTauri` flag sees the mock), then
  // render <App/> directly — the desktop-only gate is skipped.
  // The dynamic import keeps `./demo/tauri-mock` (+ bundled catalog.json) out
  // of the normal Tauri build via dead-branch elimination (VITE_DEMO unset).
  if (import.meta.env.VITE_DEMO) {
    const { installDemoMock, resolveDemoDisplayDefaults } = await import('./demo/tauri-mock');
    installDemoMock();
    // Demo-only display defaults (embed fits better at 0.9x / 12px).
    // URL override (?scale=0.9&font=12) wins; applied to DOM BEFORE App mounts
    // so first paint already uses demo density. Desktop defaults untouched.
    try {
      const display = resolveDemoDisplayDefaults();
      const factor = Number(display.ui_scale) / 100;
      if (Number.isFinite(factor) && factor > 0) {
        document.documentElement.style.zoom = `${factor}`;
        document.documentElement.style.setProperty('--app-zoom', `${factor}`);
      }
      document.documentElement.setAttribute('data-font-size', display.font_size);
      // Mirrors FONT_SCALE_MAP in useAppSettings (demo layer only, never edited there).
      const fontScale: Record<string, string> = {
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
      document.documentElement.style.setProperty('--font-scale', fontScale[display.font_size] ?? '1');
    } catch {
      // pre-apply is best-effort; App applies the same values via get_settings
    }
    const { initBrowserLockdown } = await import('./utils/browserLockdown');
    initBrowserLockdown();
    const { App } = await import('./App');
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    return;
  }

  const { initBrowserLockdown } = await import('./utils/browserLockdown');
  initBrowserLockdown();
  const [{ isTauri }, { App }] = await Promise.all([
    import('./services/api'),
    import('./App'),
  ]);

  // Z-Store 仅以 Tauri 桌面端形态运行；浏览器直接打开时给出明确提示，不做模拟降级
  if (!isTauri) {
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          background: 'var(--bg-primary, #141414)',
          color: 'var(--text-primary, #ffffff)',
        }}
      >
        <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', margin: 0 }}>Z-Store 需要在桌面端运行</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          当前浏览器环境无法访问系统 API，请通过 Tauri 桌面应用启动（pnpm tauri dev）。
        </p>
      </div>
    );
  } else {
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  }
}

void bootstrap();
