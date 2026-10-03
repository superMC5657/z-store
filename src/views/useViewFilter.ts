import { useMemo, useState } from 'react';
import type { AppSummary } from '../types';

/**
 * B3-G12 前端收敛：各 View 共用的文本过滤逻辑。
 *
 * 收敛前 FavoritesView 内联的 `matchesSearch`（按名称 / 别名 /
 * 仓库坐标过滤）与其他 View 的即席过滤各自为政；统一收敛到此模块，
 * View 侧只消费谓词与 hook，不再内联重复形状。
 */

/** 单条应用是否命中查询（名称 / 别名 / owner / repo / 描述 / 分类）。 */
export function matchesAppText(app: AppSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    app.name.toLowerCase().includes(q) ||
    (app.description_en && app.description_en.toLowerCase().includes(q)) ||
    app.owner.toLowerCase().includes(q) ||
    app.repo.toLowerCase().includes(q) ||
    app.description.toLowerCase().includes(q) ||
    app.category_name.toLowerCase().includes(q)
  );
}

/** 纯函数：按查询过滤应用列表（空查询返回原数组）。 */
export function filterAppsByQuery(apps: AppSummary[], query: string): AppSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return apps;
  return apps.filter((a) => matchesAppText(a, q));
}

/** 状态 hook：持有查询串并派生过滤结果（Favorites / 收藏关注搜索框等消费）。 */
export function useViewFilter(apps: AppSummary[], initialQuery = ''): {
  query: string;
  setQuery: (q: string) => void;
  filtered: AppSummary[];
} {
  const [query, setQuery] = useState(initialQuery);
  const filtered = useMemo(() => filterAppsByQuery(apps, query), [apps, query]);
  return { query, setQuery, filtered };
}
