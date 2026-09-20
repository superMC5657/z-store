import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // 专为 Tauri 开发定制的 Vite 选项，仅在 `tauri dev` 或 `tauri build` 时生效
  //
  // 1. 防止 Vite 清屏遮挡 Rust 错误输出
  clearScreen: false,
  // 2. Tauri 需要固定端口，若端口不可用则直接报错退出
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 1421,
    },
  },
  // 3. 允许访问以 TAURI_ 开头的环境变量
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri 支持 es2021
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // 调试构建时不压缩代码
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    // 调试构建时生成 SourceMap
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
