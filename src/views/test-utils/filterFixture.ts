import type { AppSummary } from '../../types';
import { matchPlatformSet } from '../../lib/platformFilter';

/**
 * B3-G12 前端收敛：各 View 测试共用的应用夹具。
 *
 * 收敛前 Home / Categories / Trends / Favorites 的测试文件各自内联
 * `makeApp` 与平台交集数据（rustdesk:windows、仅 ios、platforms 缺省），
 * 此处统一提供，测试文件只消费夹具。
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

/** 共享交集数据：rustdesk:windows、仅 ios、platforms 缺省（视作 windows）。 */
export function basePlatformFixture(): { rustdesk: AppSummary; iosOnly: AppSummary; noPlatforms: AppSummary } {
  return {
    rustdesk: makeApp({ id: 'rustdesk', name: 'RustDesk', platforms: ['windows'], stars: 90000 }),
    iosOnly: makeApp({ id: 'ios-only-app', name: '仅iosApp', platforms: ['ios'], stars: 5000 }),
    noPlatforms: makeApp({ id: 'no-platforms-app', name: '无platformsApp', stars: 3000 }),
  };
}
