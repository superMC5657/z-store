/**
 * 视图/组件层直调 Tauri IPC 卡点测试（替代 eslint no-direct-invoke）：
 *
 * - 递归扫描 `src/views` 与 `src/components` 下全部生产源码（`*.ts`/`*.tsx`，
 *   排除 `*.test.*`），子目录（TrendsView/SettingsView/HomeView 等）同样受检。
 * - 两层禁止直调 Tauri IPC：后端命令一律经 `src/services/api.ts` 的
 *   `tauriApi` 方法，命令名统一收敛于表驱动 `CMD`；窗口控制/进程控制等
 *   `@tauri-apps/api` 与插件命令直调收敛到 services 封装（services/window.ts、
 *   services/appProcess.ts，豁免理由见各封装头注释）。
 * - 禁止导入 `@tauri-apps/api/*`（core/window 等 core API）与
 *   `services/api/client`（`tauriInvoke` 底层直调口）；官方插件 JS API
 *   （`@tauri-apps/plugin-*`，如 plugin-updater）视为合法高层封装不在此列。
 * - 引用 `services/api` 的 View 必须使用 `tauriApi` 命名。
 * - `api.ts` 必须导出表驱动 `CMD`。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewsDir = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.resolve(viewsDir, '../components');
const apiPath = path.resolve(viewsDir, '../services/api.ts');

// 仅匹配真正的 import 行（行首 `import`，注释行一律忽略）；相对层级不限
// （`../`、`../../`…），裸 `services/api` 与 `services/api/client` 均覆盖。
const apiImportLine = /^\s*import\b.*from\s*['"](?:\.\.\/)+services\/api(?:\/client)?['"]/;
const apiClientImportLine = /^\s*import\b.*from\s*['"](?:\.\.\/)+services\/api\/client['"]/;

function hasImportLine(text: string, re: RegExp): boolean {
  return text.split('\n').some((line) => re.test(line));
}

function walkSources(rootDirs: [string, string][]): { layer: string; file: string; text: string }[] {
  const out: { layer: string; file: string; text: string }[] = [];
  const walk = (layer: string, dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(layer, full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (entry.name.includes('.test.')) continue;
      out.push({
        layer,
        file: `${layer}/${path.relative(dir, full)}`,
        text: fs.readFileSync(full, 'utf8'),
      });
    }
  };
  for (const [layer, dir] of rootDirs) walk(layer, dir);
  return out;
}

const gatedLayers = (): { layer: string; file: string; text: string }[] =>
  walkSources([
    ['views', viewsDir],
    ['components', componentsDir],
  ]);

describe('views/components go through services, never invoke directly', () => {
  it('no direct Tauri call in gated production sources', () => {
    const directCall = new RegExp('invoke\\s*\\(');
    const offenders = gatedLayers()
      .filter(({ text }) => directCall.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('no @tauri-apps/api import in gated production sources', () => {
    // 整个 core API 前缀（api/core、api/window…）一律禁用；插件 JS API
    // （@tauri-apps/plugin-*）不受限。
    const offenders = gatedLayers()
      .filter(({ text }) => text.includes('@tauri-apps/api'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('no services/api/client import in gated production sources', () => {
    const offenders = gatedLayers()
      .filter(({ text }) => hasImportLine(text, apiClientImportLine))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('views importing services/api use the tauriApi name', () => {
    const offenders = gatedLayers()
      .filter(({ layer, text }) => layer === 'views' && hasImportLine(text, apiImportLine) && !text.includes('tauriApi'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('api.ts exposes the table-driven CMD map used by tauriApi', () => {
    const apiText = fs.readFileSync(apiPath, 'utf8');
    expect(apiText).toContain('export const CMD = {');
    expect(apiText).toContain('export const tauriApi = {');
  });
});
