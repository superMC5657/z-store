/**
 * mock 安装器必须先于 `services/api/client.ts` 求值：后者在模块顶层判定 `isTauri`，
 * 若 tauri-mock 的运行时 import 链提前拉到它，整个演示站都会报「Not in Tauri environment」。
 * 这里沿 tauri-mock.ts 的非 `import type` 依赖静态遍历，断言链上没有 client.ts。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENTRY = resolve(__dirname, 'tauri-mock.ts');
const FORBIDDEN = resolve(__dirname, '../services/api/client.ts');

function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec.replace(/\?raw$/, ''));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (/\.(tsx?)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** 运行时依赖：排除 `import type` / `export type`，包含 `import x from` 与 `export … from`。 */
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gms;
  for (const m of src.matchAll(re)) specs.push(m[2]);
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  return specs.map((s) => resolveModule(file, s)).filter((p): p is string => p !== null);
}

function findPath(entry: string, target: string): string[] | null {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file === target) {
      const path: string[] = [];
      for (let cur: string | null = file; cur; cur = parent.get(cur) ?? null) path.unshift(cur);
      return path;
    }
    for (const dep of runtimeImports(file)) {
      if (!parent.has(dep)) {
        parent.set(dep, file);
        queue.push(dep);
      }
    }
  }
  return null;
}

describe('demo mock import graph', () => {
  it('never reaches services/api/client.ts at runtime', () => {
    const path = findPath(ENTRY, FORBIDDEN);
    expect(path?.map((p) => p.slice(resolve(__dirname, '..').length + 1)) ?? null).toBeNull();
  });
});
