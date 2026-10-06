import {
  PLATFORM_IDS,
  normalizePlatform,
  type PlatformId,
} from '../lib/platformFilter';

export const PLATFORM_FILTER_STORAGE_KEY = 'zstore:platform-filter:v2';
/** 5-ID 旧世界的遗留键：仅用于一次性升级读取，绝不回写。 */
export const LEGACY_PLATFORM_FILTER_STORAGE_KEY = 'zstore:platform-filter:v1';
/** 旧世界 5 端 ID：遗留全选（= 展示全部意图）升级为 6 端全选，避免静默隐藏类库。 */
export const LEGACY_OS_PLATFORM_IDS: readonly string[] = ['windows', 'macos', 'linux', 'ios', 'android'];

/**
 * 将原始 localStorage 字符串解析为经过验证的平台选择集合。
 * 未知 ID 会被白名单过滤剔除。有效（可解析）的数组将按原样处理——
 * 包括空数组（这是合法的选择，代表空列表，各页面会据此渲染筛选为空的引导状态），
 * 以及仅含未知项的数组（根据同一规则过滤缩减为 []）。
 * 仅在键缺失或 JSON 损坏/非数组时，才会回退至全选集合（等效于“无过滤”）。
 *
 * 注意：此函数与 `src/lib/platformFilter.ts` 中的 `parseSelectedPlatformArray` 有所区别——
 * 后者接收已解码的字符串数组（readonly string[] | null | undefined）并将 null/undefined
 * 映射为空集合（绝不回退至全选）。而本字符串版本接收原始存储字符串，在缺失或损坏时有意回退至全选。
 */
export function parseSelectedPlatforms(raw: string | null | undefined): Set<PlatformId> {
  const full = new Set<PlatformId>(PLATFORM_IDS);
  if (!raw) return full;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return full;
  }
  if (!Array.isArray(parsed)) return full;
  const known = new Set<PlatformId>();
  for (const id of parsed) {
    if (typeof id !== 'string') continue;
    const n = normalizePlatform(id);
    if ((PLATFORM_IDS as readonly string[]).includes(n)) known.add(n as PlatformId);
  }
  return known;
}

/**
 * 首次渲染时读取持久化的平台选择。保证绝不抛错：
 * 存储缺失、值损坏或存储抛错均产生全选集合；
 * 存储为有效的空数组则产生空集合。
 *
 * v1 → v2 一次性升级：v2 缺席时读取遗留 v1 键。任何遗留 v1 集合一律补上虚拟 other
 * （发现性默认，与新用户全 6 端一致；用户可自行取消勾选）。
 * v2 集合原样沿用，绝不触碰。
 */
export function loadSelectedPlatforms(): Set<PlatformId> {
  const full = new Set<PlatformId>(PLATFORM_IDS);
  try {
    if (typeof window === 'undefined' || !window.localStorage) return full;
    const current = window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY);
    if (current !== null) return parseSelectedPlatforms(current);
    const legacy = window.localStorage.getItem(LEGACY_PLATFORM_FILTER_STORAGE_KEY);
    if (!legacy) return full;
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacy);
    } catch {
      return full;
    }
    if (!Array.isArray(parsed)) return full;
    const migrated = parseSelectedPlatforms(JSON.stringify(parsed));
    // 旧世界 5 端 ID 全集即“展示全部”意图；子集亦补 other，保证类库默认可见。
    void LEGACY_OS_PLATFORM_IDS;
    migrated.add('other');
    return migrated;
  } catch {
    return full;
  }
}
