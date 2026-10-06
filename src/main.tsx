import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import './styles/fluent.css';
import { initZLog } from './lib/z-log';
import { appZoomFactor, fontScaleFor } from './utils/density';

void initZLog();

async function bootstrap(): Promise<void> {
  // Live-demo 嵌入页（`/live-demo`）：在执行任何 `services/api` 代码前安装 Tauri mock
  // （以便其 `isTauri` 标记能够识别到 mock），随后直接渲染 <App/>——跳过仅限桌面端的环境门禁。
  // 动态导入结合死代码消除（未设置 VITE_DEMO 时），可确保 `./demo/tauri-mock`
  // （以及随附打包的 catalog.json）不会混入常规 Tauri 构建产物中。
  if (import.meta.env.VITE_DEMO) {
    const { installDemoMock, resolveDemoDisplayDefaults } = await import('./demo/tauri-mock');
    installDemoMock();
    // 仅限 Demo 的默认显示配置（嵌入页更适合 0.9x 缩放 / 12px 字号）。
    // URL 参数覆盖（?scale=0.9&font=12）优先级最高；在 App 挂载前应用至 DOM，
    // 以保证首次渲染即使用 Demo 显示密度。桌面端默认设置不受影响。
    try {
      const display = resolveDemoDisplayDefaults();
      const demoFactor = appZoomFactor(display.ui_scale);
      if (demoFactor !== null) {
        document.documentElement.style.setProperty('--app-zoom', `${demoFactor}`);
      }
      document.documentElement.setAttribute('data-font-size', display.font_size);
      document.documentElement.style.setProperty('--font-scale', fontScaleFor(display.font_size));
    } catch {
      // 预先应用属于尽力而为（best-effort）；App 后续会通过 get_settings 应用相同数值
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
