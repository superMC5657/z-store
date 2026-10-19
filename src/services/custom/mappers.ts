/**
 * 草稿线格式 ↔ 领域形状的唯一转换口。
 *
 * 视图与 API 客户端都只认 `DraftEntry` / `DraftItem`；`null` 与空串的归一、
 * `is_verified` 的写入约束、`stars/forks` 的缺省都只在这里发生。
 */
import type { AppSummary } from '../../types';
import type {
  DraftEntry,
  DraftEntryWire,
  DraftItem,
  DraftItemWire,
  DraftStatus,
} from './types';

const DEFAULT_ICON_BG = 'linear-gradient(135deg, #475569, #334155)';

/** 线格式状态 → 领域状态（`local_collected` 与 `collected` 同义）。 */
export function draftStatusFromWire(status: string): DraftStatus {
  if (status === 'submitted') return 'submitted';
  if (status === 'collected' || status === 'local_collected') return 'collected';
  return 'draft';
}

/** 线格式 payload → 领域 item（null 归一为空串，数值缺省为 0）。 */
export function itemFromWire(wire: DraftItemWire): DraftItem {
  return {
    id: wire.id,
    name: wire.name ?? '',
    owner: wire.owner ?? '',
    repo: wire.repo ?? '',
    icon: wire.icon ?? '',
    icon_bg: wire.icon_bg ?? '',
    description: wire.description ?? '',
    description_en: typeof wire.description_en === 'string' ? wire.description_en : '',
    category: wire.category ?? '',
    category_name: wire.category_name ?? '',
    aliases: wire.aliases ?? [],
    default_version: wire.default_version ?? 'v0.1.0',
    license: wire.license ?? '',
    homepage: typeof wire.homepage === 'string' ? wire.homepage : '',
    install_dirs: wire.install_dirs ?? [],
    search_subdirs: wire.search_subdirs ?? [],
    publishers: wire.publishers ?? [],
    platforms: wire.platforms ?? [],
    identifiers: wire.identifiers ?? {},
    stars: typeof wire.stars === 'number' && Number.isFinite(wire.stars) ? wire.stars : 0,
    forks: typeof wire.forks === 'number' && Number.isFinite(wire.forks) ? wire.forks : 0,
  };
}

/** 后端行 → 领域条目（视图与 App 状态一律持有此形状）。 */
export function entryFromWire(wire: DraftEntryWire): DraftEntry {
  return {
    id: wire.id,
    item: itemFromWire(wire.item),
    status: draftStatusFromWire(wire.status),
    pr_url: wire.pr_url ?? null,
    archived: wire.archived,
    updated_at: wire.updated_at,
  };
}

/**
 * 领域 item → 保存 payload：
 * 空串归 `null`（对齐后端 Option）、`is_verified` 恒 false、
 * `stars/forks` 沿用已有行真值（表单不编辑）。
 */
export function itemToWire(
  item: DraftItem,
  existing?: Pick<DraftItem, 'stars' | 'forks'>,
): DraftItemWire {
  return {
    id: item.id,
    name: item.name,
    owner: item.owner,
    repo: item.repo,
    icon: item.icon,
    icon_bg: item.icon_bg,
    description: item.description,
    description_en: item.description_en.trim() ? item.description_en : null,
    category: item.category,
    category_name: item.category_name,
    aliases: item.aliases,
    default_version: item.default_version,
    license: item.license,
    stars: existing?.stars ?? item.stars ?? 0,
    forks: existing?.forks ?? item.forks ?? 0,
    is_verified: false,
    homepage: item.homepage.trim() ? item.homepage : null,
    install_dirs: item.install_dirs,
    search_subdirs: item.search_subdirs,
    publishers: item.publishers,
    platforms: item.platforms,
    identifiers: item.identifiers,
  };
}

/**
 * 草稿 → 卡片摘要（唯一投影：待收录与本地收录行共用）。
 * `source=local` + 显式 status 供黄标判定；`archived` 仅在调用方传入时携带
 * （待收录路径无归档概念，收录行路径透传行真值）。
 */
export function itemToSummary(
  item: DraftItem,
  status: DraftStatus,
  archived?: boolean,
): AppSummary & { source: 'local'; status: string; archived?: boolean } {
  return {
    id: item.id,
    name: item.name || item.id,
    owner: item.owner,
    repo: item.repo,
    icon: item.icon,
    icon_bg: item.icon_bg || DEFAULT_ICON_BG,
    description: item.description,
    description_en: item.description_en || undefined,
    stars: typeof item.stars === 'number' && Number.isFinite(item.stars) ? item.stars : 0,
    forks: typeof item.forks === 'number' && Number.isFinite(item.forks) ? item.forks : 0,
    license: item.license,
    latest_version: item.default_version || 'v0.1.0',
    category: item.category || 'dev',
    category_name: item.category_name || item.category || 'dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: item.homepage || null,
    platforms: [...(item.platforms ?? [])],
    source: 'local',
    status,
    ...(archived === undefined ? {} : { archived }),
  };
}

/** 本地收录行 → 合并视图摘要（保留 status/archived，供去重与黄标）。 */
export function entryToCollectedSummary(
  entry: DraftEntry,
): AppSummary & { status: string; archived: boolean } {
  return itemToSummary(entry.item, entry.status, entry.archived) as AppSummary & {
    status: string;
    archived: boolean;
  };
}
