import { useMemo, useState } from 'react';
import type { AppSummary } from '../types';

/**
 * 各 View 共用的文本过滤逻辑。
 *
 * View 侧只消费谓词与 hook，不内联重复过滤形状。
 */

/** 单条应用是否命中查询（名称 / owner / repo / 分类）。 */
export function matchesAppText(app: AppSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    app.name.toLowerCase().includes(q) ||
    app.owner.toLowerCase().includes(q) ||
    app.repo.toLowerCase().includes(q) ||
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
