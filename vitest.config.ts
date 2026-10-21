import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**'],
      // 演示壳与类型声明不计入；`pnpm build:demo` 的 mock 面无生产语义。
      exclude: ['src/demo/**', 'src/@types/**', 'src/**/*.d.ts', 'src/vite-env.d.ts'],
    },
  },
});
