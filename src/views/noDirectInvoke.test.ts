/**
 * View 层直调 Tauri IPC 卡点测试（替代 eslint no-direct-invoke）：
 *
 * - 递归扫描 `src/views` 下全部生产源码（`*.ts`/`*.tsx`，排除 `*.test.*`），
 *   子目录（TrendsView/SettingsView/HomeView 等）同样受检。
 * - View 层禁止直调 Tauri IPC：全部调用必须经 `src/services/api.ts` 的
 *   `tauriApi` 方法，命令名统一收敛于表驱动 `CMD`。
 * - View 层禁止导入 `@tauri-apps/api/core` 与 `services/api/client`
 *  （`tauriInvoke` 底层直调口）；只许经 `tauriApi` + `CMD`。
 * - 引用 `services/api` 的 View 必须使用 `tauriApi` 命名。
 * - `api.ts` 必须导出表驱动 `CMD`。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewsDir = path.dirname(fileURLToPath(import.meta.url));
const apiPath = path.resolve(viewsDir, '../services/api.ts');

// 仅匹配真正的 import 行（行首 `import`，注释行一律忽略）；相对层级不限
// （`../`、`../../`…），裸 `services/api` 与 `services/api/client` 均覆盖。
const apiImportLine = /^\s*import\b.*from\s*['"](?:\.\.\/)+services\/api(?:\/client)?['"]/;
const apiClientImportLine = /^\s*import\b.*from\s*['"](?:\.\.\/)+services\/api\/client['"]/;

function hasImportLine(text: string, re: RegExp): boolean {
  return text.split('\n').some((line) => re.test(line));
}

function viewSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (entry.name.includes('.test.')) continue;
      out.push({ file: path.relative(viewsDir, full), text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(viewsDir);
  return out;
}

describe('views go through tauriApi, never invoke directly', () => {
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

  it('no services/api/client import in src/views', () => {
    const offenders = viewSources()
      .filter(({ text }) => hasImportLine(text, apiClientImportLine))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('views importing services/api use the tauriApi name', () => {
    const offenders = viewSources()
      .filter(({ text }) => hasImportLine(text, apiImportLine) && !text.includes('tauriApi'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('api.ts exposes the table-driven CMD map used by tauriApi', () => {
    const apiText = fs.readFileSync(apiPath, 'utf8');
    expect(apiText).toContain('export const CMD = {');
    expect(apiText).toContain('export const tauriApi = {');
  });
});
