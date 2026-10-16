import { describe, expect, it } from 'vitest';
import { CMD, tauriApi } from '../api';
import { getLicenseAllowlist } from './catalog';

describe('license allowlist wiring (ADR-0018)', () => {
  it('exposes the table-driven command and tauriApi method', () => {
    expect(CMD.getLicenseAllowlist).toBe('get_license_allowlist');
    expect(tauriApi.getLicenseAllowlist).toBe(getLicenseAllowlist);
  });

  it('rejects outside Tauri instead of falling back to a baked-in list', async () => {
    await expect(getLicenseAllowlist()).rejects.toThrow();
  });
});
