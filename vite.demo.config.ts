import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Live-demo embed: static browser bundle for the `/live-demo` embed.
// Contract: demo static output goes to
//   Z:\web_workplace\z-store-web/public/live-demo/  with base `/live-demo/`.
// This config is ONLY used by `pnpm run build:demo`; normal Tauri builds use
// vite.config.ts and never see VITE_DEMO / the demo mock (+ catalog.json).
//
// Forcing VITE_DEMO here (in addition to the `VITE_DEMO=1` script prefix)
// keeps `pnpm run build:demo` working on Windows shells where `FOO=bar`
// prefixes are unsupported (cmd.exe / pwsh).
process.env.VITE_DEMO ??= '1';

// Vite 配置文档参考：https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  base: '/live-demo/',

  // 允许访问以 TAURI_ 开头的环境变量（与主配置保持一致）
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  // Guarantee the demo gate (`import.meta.env.VITE_DEMO` in main.tsx /
  // demo/tauri-mock.ts) is truthy in this bundle regardless of shell env.
  define: {
    'import.meta.env.VITE_DEMO': '"1"',
  },

  build: {
    target: 'es2021',
    outDir: '../../web_workplace/z-store-web/public/live-demo',
    emptyOutDir: true,
  },
});
