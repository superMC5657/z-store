import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Live-demo 嵌入页：用于 `/live-demo` 嵌入场景的浏览器静态打包配置。
// 约定：Demo 静态产物输出至
//   Z:\web_workplace\z-store-web/public/live-demo/，且 base 为 `/live-demo/`。
// 此配置仅供 `pnpm run build:demo` 使用；常规 Tauri 构建使用
// vite.config.ts，绝不会引入 VITE_DEMO / Demo mock（以及 catalog.json）。
//
// 此处强制设置 VITE_DEMO（除了脚本前缀中的 `VITE_DEMO=1` 之外），
// 可确保 `pnpm run build:demo` 在不支持 `FOO=bar` 前缀的 Windows 终端（cmd.exe / pwsh）中正常工作。
process.env.VITE_DEMO ??= '1';

// Vite 配置文档参考：https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  base: '/live-demo/',

  // 允许访问以 TAURI_ 开头的环境变量（与主配置保持一致）
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  // 确保无论外部终端环境如何，当前 bundle 中的 Demo 开关（main.tsx /
  // demo/tauri-mock.ts 内的 `import.meta.env.VITE_DEMO`）始终为真。
  define: {
    'import.meta.env.VITE_DEMO': '"1"',
  },

  build: {
    target: 'es2021',
    outDir: '../../web_workplace/z-store-web/public/live-demo',
    emptyOutDir: true,
  },
});
