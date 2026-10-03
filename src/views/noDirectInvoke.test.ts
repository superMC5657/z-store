/**
 * B3-G12 前端收敛卡点（替代 eslint no-direct-invoke；根配置不在本任务允许范围）：
 *
 * - View 层禁止直调 Tauri IPC：全部调用必须经 `src/services/api.ts` 的
 *   `tauriApi` 方法，命令名统一收敛于表驱动 `CMD`。
 * - View 层禁止导入 `@tauri-apps/api/core`。
 * - 引用 `../services/api` 的 View 必须使用 `tauriApi` 命名（`api` 仅为历史别名）。
 * - `api.ts` 必须导出表驱动 `CMD`。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewsDir = path.dirname(fileURLToPath(import.meta.url));
const apiPath = path.resolve(viewsDir, '../services/api.ts');

function viewSources(): { file: string; text: string }[] {
  return fs
    .readdirSync(viewsDir)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((file) => ({ file, text: fs.readFileSync(path.join(viewsDir, file), 'utf8') }));
}

describe('B3-G12: views go through tauriApi, never invoke directly', () => {
  it('no direct Tauri call in src/views production components', () => {
    const directCall = new RegExp('invoke\\s*\\(');
    const offenders = viewSources()
      .filter(({ text }) => directCall.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('no @tauri-apps/api/core import in src/views', () => {
    const offenders = viewSources()
      .filter(({ text }) => text.includes('@tauri-apps/api/core'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('views importing ../services/api use the tauriApi name', () => {
    const offenders = viewSources()
      .filter(({ text }) => text.includes('../services/api') && !text.includes('tauriApi'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('api.ts exposes the table-driven CMD map used by tauriApi', () => {
    const apiText = fs.readFileSync(apiPath, 'utf8');
    expect(apiText).toContain('export const CMD = {');
    expect(apiText).toContain('export const tauriApi = {');
  });
});
