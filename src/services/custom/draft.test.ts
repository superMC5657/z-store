/**
 * 移入收录唯一入口（`moveInToDraft`）：
 * - 图标只认 remote http(s) 真值，探测失败回退摘要归一；
 * - 落库成功才广播 `zstore:custom-apps-changed`；
 * - 落库失败返回 ok=false，不抛异常（视图负责本地化提示）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tauriApi } from '../api';
import { moveInToDraft } from './draft';
import type { AppSummary } from '../../types';

function onlineApp(extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id: 'acme/atlas',
    name: 'Atlas',
    owner: 'acme',
    repo: 'atlas',
    icon: '',
    icon_bg: '',
    description: 'Atlas tool',
    stars: 5,
    forks: 1,
    license: 'OpenSource',
    latest_version: 'latest',
    category: 'external',
    category_name: '跨平台开源',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    ...extra,
  } as AppSummary;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moveInToDraft（移入收录唯一入口）', () => {
  it('remote 图标真值优先，落库后广播变更事件', async () => {
    const cycleSpy = vi
      .spyOn(tauriApi, 'restoreOrFetchIconCycle')
      .mockResolvedValue({ remote_url: 'https://example.com/atlas.png' } as never);
    const saveSpy = vi.spyOn(tauriApi, 'saveCustomApp').mockResolvedValue({} as never);
    const events: string[] = [];
    const onChanged = (e: Event) => events.push((e as CustomEvent).detail?.id);
    window.addEventListener('zstore:custom-apps-changed', onChanged);

    const res = await moveInToDraft(onlineApp());

    expect(res.ok).toBe(true);
    expect(res.id).toBe('acme/atlas');
    expect(cycleSpy).toHaveBeenCalledWith('acme/atlas');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const payload = saveSpy.mock.calls[0]?.[0];
    expect(payload?.id).toBe('acme/atlas');
    expect(payload?.is_verified).toBe(false);
    expect(payload?.icon).toBe('https://example.com/atlas.png');
    // 事件 detail 带 canonical id（视图据此抑制重复移入入口）
    expect(events).toEqual(['acme/atlas']);

    window.removeEventListener('zstore:custom-apps-changed', onChanged);
  });

  it('探测失败回退摘要图标归一，落库失败不广播且返回原因', async () => {
    vi.spyOn(tauriApi, 'restoreOrFetchIconCycle').mockRejectedValue(new Error('ipc down'));
    const saveSpy = vi
      .spyOn(tauriApi, 'saveCustomApp')
      .mockRejectedValue(new Error('db locked'));
    const events: string[] = [];
    const onChanged = (e: Event) => events.push((e as CustomEvent).detail?.id);
    window.addEventListener('zstore:custom-apps-changed', onChanged);

    const res = await moveInToDraft(
      onlineApp({ id: 'acme/Beacon', owner: 'acme', repo: 'Beacon', icon: 'data:image/png;base64,AA' }),
    );

    expect(res.ok).toBe(false);
    expect(res.id).toBe('acme/beacon');
    expect(res.error).toContain('db locked');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    // data: 展示态永不出现在草稿 payload
    expect(saveSpy.mock.calls[0]?.[0]?.icon).toBe('');
    expect(events).toEqual([]);

    window.removeEventListener('zstore:custom-apps-changed', onChanged);
  });
});
