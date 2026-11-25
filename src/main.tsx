import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import './styles/fluent.css';
import { initZLog } from './lib/z-log';
import { appZoomFactor, fontScaleFor } from './utils/density';
import { ErrorBoundary } from './components/ErrorBoundary';

void initZLog();

async function bootstrap(): Promise<void> {
  // Live-demo 入口：在加载 services/api 前安装 Tauri mock 以跳过桌面端门禁；常规构建由 tree-shaking 剔除。
  if (import.meta.env.VITE_DEMO) {
    const { installDemoMock, resolveDemoDisplayDefaults } = await import('./demo/tauri-mock');
    installDemoMock();
    // 预先应用 Demo 显示密度（URL 参数优先级最高），确保首帧渲染一致。
    try {
      const display = resolveDemoDisplayDefaults();
      const demoFactor = appZoomFactor(display.ui_scale);
      if (demoFactor !== null) {
        document.documentElement.style.setProperty('--app-zoom', `${demoFactor}`);
      }
      document.documentElement.setAttribute('data-font-size', display.font_size);
      document.documentElement.style.setProperty('--font-scale', fontScaleFor(display.font_size));
      if (display.theme) {
        const effective = display.theme === 'system'
          ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : display.theme;
        document.documentElement.setAttribute('data-theme', effective);
      }
      if (display.language) {
        document.documentElement.lang = display.language;
        const i18n = (await import('./i18n')).default;
        void i18n.changeLanguage(display.language);
      }
    } catch {
      // 预先应用属于尽力而为（best-effort）；App 后续会通过 get_settings 应用相同数值
    }
    const [{ initBrowserLockdown }, { tauriApi }, { App }] = await Promise.all([
      import('./utils/browserLockdown'),
      import('./services/api'),
      import('./App'),
    ]);
    initBrowserLockdown((url) => tauriApi.openUrl(url));
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
    return;
  }

  const [{ initBrowserLockdown }, { isTauri, tauriApi }, { App }] = await Promise.all([
    import('./utils/browserLockdown'),
    import('./services/api'),
    import('./App'),
  ]);
  initBrowserLockdown((url) => tauriApi.openUrl(url));

  // ZStore 仅以 Tauri 桌面端形态运行；浏览器直接打开时给出明确提示，不做模拟降级
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
          background: 'var(--bg-canvas, #141414)',
          color: 'var(--text-primary, #ffffff)',
        }}
      >
        <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', margin: 0 }}>ZStore 需要在桌面端运行</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          当前浏览器环境无法访问系统 API，请通过 Tauri 桌面应用启动（pnpm tauri dev）。
        </p>
      </div>
    );
  } else {
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  }
}

void bootstrap();
