import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localWebPublic = resolve(__dirname, '../../web_workplace/z-store-web/public');
const defaultOutDir = existsSync(localWebPublic)
  ? resolve(localWebPublic, 'live-demo')
  : 'dist-demo';

// Live-demo 嵌入页：用于 `/live-demo` 嵌入场景的浏览器静态打包配置。
// 约定：
// 1. 本地开发且邻近存在 z-store-web 时，默认输出至 z-store-web/public/live-demo 供本地集成验证
// 2. CI/独立打包时，输出至 dist-demo（可通过环境变量 DEMO_OUT_DIR 覆盖）
process.env.VITE_DEMO ??= '1';

// Vite 配置文档参考：https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  base: process.env.VITE_BASE || './',

  // 允许访问以 TAURI_ 开头的环境变量（与主配置保持一致）
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  // 确保无论外部终端环境如何，当前 bundle 中的 Demo 开关（main.tsx /
  // demo/tauri-mock.ts 内的 `import.meta.env.VITE_DEMO`）始终为真。
  define: {
    'import.meta.env.VITE_DEMO': '"1"',
  },

  build: {
    target: 'es2021',
    outDir: process.env.DEMO_OUT_DIR || defaultOutDir,
    emptyOutDir: true,
  },
});
