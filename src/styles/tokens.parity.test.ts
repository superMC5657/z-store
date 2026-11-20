/** 校验 TS 侧 `DEFAULT_ICON_BG` 与 Rust 侧同名常量保持等值。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ICON_BG } from './tokens';

const here = path.dirname(fileURLToPath(import.meta.url));
const rustHttpPath = path.resolve(here, '../../src-tauri/src/github/http.rs');

/** 解析 Rust 侧 `const DEFAULT_ICON_BG: &str = "..."` 的字面量；缺失返回 null。 */
function rustDefaultIconBg(): string | null {
  const text = fs.readFileSync(rustHttpPath, 'utf8');
  const m = text.match(/const\s+DEFAULT_ICON_BG\s*:\s*&str\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

describe('DEFAULT_ICON_BG parity between TS tokens and Rust http', () => {
  it('parses the Rust constant from http.rs', () => {
    const rustValue = rustDefaultIconBg();
    // 解析失败（常量改名/搬迁）应当报错，而不是静默跳过比对。
    expect(rustValue, `DEFAULT_ICON_BG not found in ${rustHttpPath}`).not.toBeNull();
  });

  it('Rust DEFAULT_ICON_BG equals the TS token value', () => {
    const rustValue = rustDefaultIconBg();
    expect(
      rustValue,
      `DEFAULT_ICON_BG diverged — TS tokens.ts: "${DEFAULT_ICON_BG}" | Rust github/http.rs: "${rustValue}"`,
    ).toBe(DEFAULT_ICON_BG);
  });
});
