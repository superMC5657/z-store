/**
 * 前端 z-log 脱敏镜像测试（与后端 `src-tauri/src/z_log.rs::redact` 同规则）。
 *
 * 安全契约镜像（样例与后端单测同源）：
 * - `Bearer/bearer/Token/token` 标记形态打码；
 * - `code/device_code/user_code/api_key/api-key/apikey` 键值打码
 *   （含 JSON 紧凑/宽松形态 `"code":"v"`，与后端 is_kv_post 含引号一致）；
 * - `vscode` 类路径段内的 `code` 子串永不触发；
 * - 邮箱整体替换 `***@***`；
 * - 宽字符混排不断裂。
 * 另锁前端特有行为：`[sid=][req=]` 前缀、1s 去重窗、initZLog 全局错误钩子脱敏。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pluginLog = vi.hoisted(() => ({
  attachConsole: vi.fn(async (): Promise<() => void> => () => {}),
  info: vi.fn((_msg: string): Promise<void> => Promise.resolve()),
  warn: vi.fn((_msg: string): Promise<void> => Promise.resolve()),
  error: vi.fn((_msg: string): Promise<void> => Promise.resolve()),
}));

vi.mock('@tauri-apps/plugin-log', () => ({
  attachConsole: pluginLog.attachConsole,
  info: pluginLog.info,
  warn: pluginLog.warn,
  error: pluginLog.error,
}));

// 模块内 sid/去重窗/isInitialized 为进程级状态：每例重载，保证互不串扰。
async function loadZLog(): Promise<typeof import('./z-log')> {
  return await import('./z-log');
}

function lastInfo(): string {
  const calls = pluginLog.info.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.resetModules();
  pluginLog.attachConsole.mockClear();
  pluginLog.info.mockClear();
  pluginLog.warn.mockClear();
  pluginLog.error.mockClear();
});

describe('z-log redact：标记形态（与后端 test_redact_bearer 同源）', () => {
  it('Bearer/bearer/Token/token 四种拼写均打码且原 token 不残留', async () => {
    const { zlogInfo } = await loadZLog();
    for (const marker of ['Bearer', 'bearer', 'Token', 'token']) {
      pluginLog.info.mockClear();
      zlogInfo(`call with ${marker} abc123xyz ok`);
      const line = lastInfo();
      expect(line).toContain(`${marker} ***`);
      expect(line).not.toContain('abc123xyz');
    }
  });

  it('逗号/分号截断 token：标记后首个分隔符起原文保留', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('Bearer abc,def tail');
    expect(lastInfo()).toContain('Bearer ***,def tail');
    pluginLog.info.mockClear();
    zlogInfo('Bearer abc;def tail');
    expect(lastInfo()).toContain('Bearer ***;def tail');
  });
});

describe('z-log redact：键值形态（与后端 test_redact_email_code_apikey 同源）', () => {
  it('code= 与 code: 形态打码，键名归一 code=***', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('contact user@example.com code=secret123 ok');
    const line = lastInfo();
    expect(line).toContain('***@***');
    expect(line).not.toContain('user@example.com');
    expect(line).not.toContain('secret123');
    pluginLog.info.mockClear();
    zlogInfo('code: secret123');
    expect(lastInfo()).toContain('code=***');
    expect(lastInfo()).not.toContain('secret123');
  });

  it('JSON 紧凑/宽松形态打码（后端 is_kv_post 含引号的镜像面）', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('{"code":"abcd-1234","api_key":"sk-live-999"}');
    const line = lastInfo();
    expect(line).not.toContain('abcd-1234');
    expect(line).not.toContain('sk-live-999');
    expect(line).toContain('code=***');
    pluginLog.info.mockClear();
    zlogInfo('{"code": "spaced"}');
    expect(lastInfo()).not.toContain('spaced');
  });

  it('device_code/user_code/api-key/apikey 打码且保留原键名大小写', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('device_code=DC-999 user_code=UC-111 api-key=AK-222');
    let line = lastInfo();
    expect(line).not.toContain('DC-999');
    expect(line).not.toContain('UC-111');
    expect(line).not.toContain('AK-222');
    expect(line).toContain('device_code=***');
    expect(line).toContain('user_code=***');
    expect(line).toContain('api-key=***');
    pluginLog.info.mockClear();
    zlogInfo('API_KEY=sk-123');
    line = lastInfo();
    expect(line).toContain('API_KEY=***');
    expect(line).not.toContain('sk-123');
  });

  it('vscode 类路径段永不触发（与后端 test_redact_vscode_url_preserved 同源）', async () => {
    const { zlogInfo } = await loadZLog();
    const u1 = 'https://api.github.com/repos/microsoft/vscode/releases/latest';
    zlogInfo(u1);
    expect(lastInfo()).toContain(u1);
    expect(lastInfo()).not.toContain('***');
    const u2 = 'https://update.code.visualstudio.com/api/update/win32-x64/stable/latest';
    pluginLog.info.mockClear();
    zlogInfo(u2);
    expect(lastInfo()).toContain(u2);
    expect(lastInfo()).not.toContain('***');
    // 真正的键值仍需脱敏。
    pluginLog.info.mockClear();
    zlogInfo('fetch ok code=secret123 done');
    expect(lastInfo()).not.toContain('secret123');
    expect(lastInfo()).toContain('***');
  });
});

describe('z-log redact：邮箱与宽字符（与后端同源样例）', () => {
  it('邮箱整体替换 ***@***', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('contact user@example.com please');
    expect(lastInfo()).toContain('***@***');
    expect(lastInfo()).not.toContain('user@example.com');
  });

  it('宽字符 + emoji 混排不断裂、打码生效（镜像 test_redact_unicode_boundary_safe）', async () => {
    const { zlogInfo } = await loadZLog();
    const msg = `${'汉'.repeat(200)} user@test.com Bearer tok 汉😀`;
    zlogInfo(msg);
    const line = lastInfo();
    expect(line).toContain('***@***');
    expect(line).toContain('Bearer ***');
    expect(line).not.toContain('user@test.com');
    // 前缀 `[sid=..] ` 之后 CJK 串原样保留、行尾宽字符不断裂（合法 UTF-8 镜像后端的 chars 遍历断言）。
    expect(line).toContain('汉'.repeat(200));
    expect(line.endsWith('汉😀')).toBe(true);
  });
});

describe('z-log 通道与前缀/去重（前端特有行为）', () => {
  it('zlogWarn / zlogError 同样脱敏', async () => {
    const { zlogWarn, zlogError } = await loadZLog();
    zlogWarn('warn Bearer aaabbb');
    expect(pluginLog.warn.mock.calls[0][0]).toContain('warn Bearer ***');
    expect(pluginLog.warn.mock.calls[0][0]).not.toContain('aaabbb');
    zlogError('err code=zzz999');
    expect(pluginLog.error.mock.calls[0][0]).toContain('err code=***');
    expect(pluginLog.error.mock.calls[0][0]).not.toContain('zzz999');
  });

  it('meta 提供 sid/req 时前缀逐字使用；无 req 时省略段', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('hello', { sid: 's1', req: 'r1' });
    expect(lastInfo()).toBe('[sid=s1][req=r1] hello');
    pluginLog.info.mockClear();
    zlogInfo('plain', { sid: 's2' });
    expect(lastInfo()).toBe('[sid=s2] plain');
  });

  it('无 meta 时进程级 sid 自动生成且跨行复用', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('first');
    zlogInfo('second');
    const sidOf = (line: string): string => /^\[sid=([^\]]+)\]/.exec(line)?.[1] ?? '';
    const sid1 = sidOf(lastInfo());
    expect(sid1).toMatch(/^s/);
    pluginLog.info.mockClear();
    zlogInfo('third');
    expect(sidOf(lastInfo())).toBe(sid1);
  });

  it('同一行 1s 内重复只送达一行（StrictMode 双调用去重）', async () => {
    const { zlogInfo } = await loadZLog();
    zlogInfo('dup-line');
    zlogInfo('dup-line');
    expect(pluginLog.info).toHaveBeenCalledTimes(1);
    zlogInfo('dup-line-2');
    expect(pluginLog.info).toHaveBeenCalledTimes(2);
  });
});

describe('initZLog：全局错误钩子脱敏', () => {
  it('window.onerror / unhandledrejection 均经脱敏上送，重复初始化只挂一次', async () => {
    const { initZLog } = await loadZLog();
    await initZLog();
    expect(pluginLog.attachConsole).toHaveBeenCalledTimes(1);
    expect(lastInfo()).toContain('frontend log inited');

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom at Bearer aaabbb', filename: 'app.js', lineno: 1, colno: 2 }),
    );
    expect(pluginLog.error).toHaveBeenCalledTimes(1);
    const onErrorLine = pluginLog.error.mock.calls[0][0] as string;
    expect(onErrorLine).toContain('[onerror]');
    expect(onErrorLine).toContain('Bearer ***');
    expect(onErrorLine).not.toContain('aaabbb');

    const rejection = Object.assign(new Event('unhandledrejection'), {
      reason: new Error('reject code=zzz888'),
    });
    window.dispatchEvent(rejection);
    expect(pluginLog.error).toHaveBeenCalledTimes(2);
    const rejLine = pluginLog.error.mock.calls[1][0] as string;
    expect(rejLine).toContain('[unhandledrejection]');
    expect(rejLine).toContain('code=***');
    expect(rejLine).not.toContain('zzz888');

    // 幂等：二次初始化不再 attachConsole / 不再重复打招呼。
    await initZLog();
    expect(pluginLog.attachConsole).toHaveBeenCalledTimes(1);
  });
});
