import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { isTauri } from './services/api';
import { initZLog } from './lib/z-log';
import './i18n';
import './styles/fluent.css';

void initZLog({ batch: 200, flushIntervalMs: 3000 });

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
      <h1 style={{ fontSize: '20px', margin: 0 }}>Z-Store 需要在桌面端运行</h1>
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
