import type { AppSummary } from '../types';

/**
 * 各 View 共用的文本过滤逻辑。
 *
 * View 侧只消费谓词，不内联重复过滤形状。
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
