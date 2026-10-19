import type { AppSummary } from '../../types';
import { matchPlatformSet } from '../../lib/platformFilter';

/**
 * 各 View 测试共用的应用夹具：`makeApp`、平台交集数据与常用构造器，
 * 测试文件只消费此处导出。
 */

export function makeApp(overrides: Partial<AppSummary> & { id: string; name: string }): AppSummary {
  return {
    owner: 'owner',
    repo: overrides.id,
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${overrides.name} desc`,
    stars: 1000,
    forks: 100,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'system',
    category_name: '系统实用',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    ...overrides,
  };
}

/** 分类维度夹具（CategoriesView 风格：makeApp(id, category, platforms?)）。 */
export function makeCategorizedApp(id: string, category: string, platforms?: string[]): AppSummary {
  return makeApp({ id, name: id, category, category_name: category, platforms: platforms ?? [] });
}

/** 与 App.tsx 派生逻辑对齐：按所选设备集合预过滤。 */
export function filterAppsByPlatform(apps: AppSummary[], selected: string[]): AppSummary[] {
  return apps.filter((a) => matchPlatformSet(a, new Set(selected)));
}
