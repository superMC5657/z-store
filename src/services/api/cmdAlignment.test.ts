/**
 * CMD 表 ⇆ 后端注册集对齐卡点（防再漂移）：
 * - 从 `src-tauri/src/lib.rs` 的 `invoke_handler(tauri::generate_handler![...])`
 *   解析后端实际注册的命令名全集；
 * - CMD 表（前端命令名唯一来源）每个值必须 ⊆ 注册集，后端摘命令而前端漏改
 *   （或拼错命令名）在此卡死；
 * - 解析健壮性：注册集为空/过小视为解析失败而非对齐通过（防正则静默失配）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CMD } from '../api';

const here = path.dirname(fileURLToPath(import.meta.url));
const libRsPath = path.resolve(here, '../../../src-tauri/src/lib.rs');

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

describe('CMD table aligns with backend invoke_handler registration', () => {
  it('parses a non-trivial registration set from lib.rs', () => {
    const registered = registeredCommands();
    // 后端当前注册 96 条；阈值只防「正则失配 → 空集 → 误绿」，非精确锁定。
    expect(registered.size).toBeGreaterThanOrEqual(50);
  });

  it('every CMD value is registered in the backend', () => {
    const registered = registeredCommands();
    const cmdValues = Object.values(CMD);
    const missing = cmdValues.filter((cmd) => !registered.has(cmd));
    expect(missing, 'CMD entries absent from invoke_handler').toEqual([]);
  });

  it('CMD table has no duplicate command values', () => {
    const values = Object.values(CMD);
    expect(new Set(values).size).toBe(values.length);
  });
});
