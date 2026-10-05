import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import './styles/fluent.css';
import { initZLog } from './lib/z-log';
import { appZoomFactor, fontScaleFor } from './utils/density';

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
      const demoFactor = appZoomFactor(display.ui_scale);
      if (demoFactor !== null) {
        document.documentElement.style.setProperty('--app-zoom', `${demoFactor}`);
      }
      document.documentElement.setAttribute('data-font-size', display.font_size);
      document.documentElement.style.setProperty('--font-scale', fontScaleFor(display.font_size));
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
