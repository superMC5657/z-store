/** 静态契约测试：禁止 src/components 引用未在 src/styles 中定义的 CSS 变量（F-37）。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(here, '../styles');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('CSS custom property references in src/components (F-37)', () => {
  it('only references CSS variables defined in src/styles', () => {
    const defined = new Set<string>();
    for (const file of walk(stylesDir)) {
      if (!file.endsWith('.css')) continue;
      const css = fs.readFileSync(file, 'utf8');
      for (const m of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
        defined.add(m[1]);
      }
    }

    const undefinedRefs: string[] = [];
    for (const file of walk(here)) {
      if (!/\.(ts|tsx)$/.test(file) || /\.test\./.test(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      src.split(/\r?\n/).forEach((line, idx) => {
        for (const m of line.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)) {
          if (!defined.has(m[1])) {
            undefinedRefs.push(`${path.relative(here, file)}:${idx + 1} -> ${m[1]}`);
          }
        }
      });
    }

    expect(undefinedRefs).toEqual([]);
  });
});
