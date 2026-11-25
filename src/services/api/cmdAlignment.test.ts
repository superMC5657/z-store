/** 校验前端 `CMD` 表与后端 `lib.rs` 及 Demo mock `tauri-mock.ts` 注册的命令全集完全对齐。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CMD } from '../api';

const here = path.dirname(fileURLToPath(import.meta.url));
const libRsPath = path.resolve(here, '../../../src-tauri/src/lib.rs');
const demoMockPath = path.resolve(here, '../../demo/tauri-mock.ts');

/** 解析 generate_handler![...] 块内 `模块路径::命令名` 的末段命令名全集。 */
function registeredCommands(): Set<string> {
  const text = fs.readFileSync(libRsPath, 'utf8');
  const block = text.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  if (!block) return new Set();
  const out = new Set<string>();
  for (const m of block[1].matchAll(/[\w:]*::(\w+)/g)) {
    out.add(m[1]);
  }
  return out;
}

/** 解析 `src/demo/tauri-mock.ts` 中 `switch (cmd)` 分发块的全部 `case '...'` 命令名。 */
function demoMockCommands(): Set<string> {
  const text = fs.readFileSync(demoMockPath, 'utf8');
  const switchStart = text.indexOf('switch (cmd)');
  if (switchStart === -1) return new Set();
  const defaultIdx = text.indexOf('default:', switchStart);
  const block = defaultIdx === -1 ? text.slice(switchStart) : text.slice(switchStart, defaultIdx);
  const out = new Set<string>();
  for (const m of block.matchAll(/\bcase\s+['"]([^'"]+)['"]\s*:/g)) {
    out.add(m[1]);
  }
  return out;
}

describe('CMD table aligns with backend invoke_handler and demo mock registration', () => {
  it('parses a non-trivial registration set from lib.rs', () => {
    const registered = registeredCommands();
    // 阈值只防「正则失配 → 空集 → 误绿」，非精确锁定。
    expect(registered.size).toBeGreaterThanOrEqual(50);
  });

  it('CMD value set equals the backend registration set', () => {
    const registered = registeredCommands();
    const cmdValues = new Set<string>(Object.values(CMD));
    // missing = CMD 有而注册无；dead = 注册有而 CMD 无（无人包装的死命令）。
    const missing = [...cmdValues].filter((cmd) => !registered.has(cmd)).sort();
    const dead = [...registered].filter((cmd) => !cmdValues.has(cmd)).sort();
    expect(
      { missing, dead },
      'CMD ⇄ invoke_handler 对称差集（missing=CMD 有而注册无，dead=注册有而 CMD 无）',
    ).toEqual({ missing: [], dead: [] });
  });

  it('CMD value set equals the demo tauri-mock switch dispatch set', () => {
    const demoCmds = demoMockCommands();
    expect(demoCmds.size).toBeGreaterThanOrEqual(50);
    const cmdValues = new Set<string>(Object.values(CMD));
    const missingInDemo = [...cmdValues].filter((cmd) => !demoCmds.has(cmd)).sort();
    const deadInDemo = [...demoCmds].filter((cmd) => !cmdValues.has(cmd)).sort();
    expect(
      { missingInDemo, deadInDemo },
      'CMD ⇄ src/demo/tauri-mock.ts 对称差集（missingInDemo=CMD 有而 Demo 缺，deadInDemo=Demo 有而 CMD 无）',
    ).toEqual({ missingInDemo: [], deadInDemo: [] });
  });

  it('CMD table has no duplicate command values', () => {
    const values = Object.values(CMD);
    expect(new Set(values).size).toBe(values.length);
  });
});
