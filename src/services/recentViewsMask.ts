import type { AppSummary } from '../types';

const RECENT_VIEWS_MASK_KEY = 'zstore_recent_views_mask';

interface RecentViewsMaskState {
  clearedAtSec: number;
  /** 遮罩生效期间在前端被重新点开的应用及其毫秒时间戳（用于 30s DB 防抖窗口内立即重现并置顶）。 */
  reopenedAt: Record<string, number>;
}

const EMPTY_MASK: RecentViewsMaskState = { clearedAtSec: 0, reopenedAt: {} };

function normalizeAppId(id: string): string {
  return id.trim().toLowerCase();
}

export function loadRecentViewsMask(): RecentViewsMaskState {
  try {
    const raw = window.localStorage.getItem(RECENT_VIEWS_MASK_KEY);
    if (!raw) return EMPTY_MASK;
    const parsed = JSON.parse(raw) as (Partial<RecentViewsMaskState> & { reopenedIds?: unknown }) | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY_MASK;
    const clearedAtSec =
      typeof parsed.clearedAtSec === 'number' && Number.isFinite(parsed.clearedAtSec) && parsed.clearedAtSec > 0
        ? Math.floor(parsed.clearedAtSec)
        : 0;
    const reopenedAt: Record<string, number> = {};
    if (parsed.reopenedAt && typeof parsed.reopenedAt === 'object' && !Array.isArray(parsed.reopenedAt)) {
      for (const [k, v] of Object.entries(parsed.reopenedAt)) {
        const key = normalizeAppId(k);
        if (key && typeof v === 'number' && Number.isFinite(v) && v > 0) {
          reopenedAt[key] = v;
        }
      }
    } else if (Array.isArray(parsed.reopenedIds)) {
      // 兼容早期数组格式
      const fallbackTs = clearedAtSec > 0 ? clearedAtSec * 1000 + 1 : 1;
      for (const entry of parsed.reopenedIds) {
        if (typeof entry === 'string') {
          const key = normalizeAppId(entry);
          if (key) reopenedAt[key] = fallbackTs;
        }
      }
    }
    return { clearedAtSec, reopenedAt };
  } catch {
    return EMPTY_MASK;
  }
}

function saveRecentViewsMask(state: RecentViewsMaskState): void {
  try {
    window.localStorage.setItem(RECENT_VIEWS_MASK_KEY, JSON.stringify(state));
  } catch {
    // 无痕模式或存储配额已满时跳过持久化，仅更新内存展示列表
  }
}

/**
 * 清空最近浏览展示：仅在前端记录遮罩水位，不删除后端 `view_history` 表数据，
 * 以便本地亲和度画像继续使用完整历史浏览信号。
 */
export function maskRecentViews(items: readonly AppSummary[] = [], nowSec = Math.floor(Date.now() / 1000)): void {
  let maxViewedAt = 0;
  for (const item of items) {
    if (typeof item.viewed_at === 'number' && Number.isFinite(item.viewed_at) && item.viewed_at > maxViewedAt) {
      maxViewedAt = Math.floor(item.viewed_at);
    }
  }
  const clearedAtSec = Math.max(Math.floor(nowSec), maxViewedAt, 1);
  saveRecentViewsMask({ clearedAtSec, reopenedAt: {} });
}

/**
 * 在清空遮罩生效期间重新点开某应用时解除对该应用的遮罩，并记录前端打开时间以保持置顶。
 */
export function unmaskRecentViewApp(appId: string, nowMs = Date.now()): void {
  const cleanId = normalizeAppId(appId);
  if (!cleanId) return;
  const current = loadRecentViewsMask();
  if (current.clearedAtSec <= 0) return;
  saveRecentViewsMask({
    clearedAtSec: current.clearedAtSec,
    reopenedAt: { ...current.reopenedAt, [cleanId]: nowMs },
  });
}

/**
 * 过滤掉被前端「清空浏览记录」遮罩的历史条目；
 * 若存在遮罩期内重开记录（命中 30s DB 防抖未更新库时间戳），按重开时间同步置顶。
 */
export function filterMaskedRecentViews<T extends AppSummary>(items: readonly T[]): T[] {
  const mask = loadRecentViewsMask();
  if (mask.clearedAtSec <= 0) return [...items];

  const indexed: Array<{ item: T; order: number; sortMs: number }> = [];
  let hasReopened = false;
  items.forEach((item, idx) => {
    const id = normalizeAppId(item.id);
    const reopenedMs = id ? mask.reopenedAt[id] : undefined;
    const viewedMs = typeof item.viewed_at === 'number' && Number.isFinite(item.viewed_at) ? item.viewed_at * 1000 : 0;
    const isAfterClear = typeof item.viewed_at === 'number' && item.viewed_at > mask.clearedAtSec;
    if (reopenedMs !== undefined) {
      hasReopened = true;
      indexed.push({ item, order: idx, sortMs: Math.max(viewedMs, reopenedMs) });
    } else if (isAfterClear) {
      indexed.push({ item, order: idx, sortMs: viewedMs });
    }
  });

  if (hasReopened && indexed.length > 1) {
    indexed.sort((a, b) => b.sortMs - a.sortMs || a.order - b.order);
  }
  return indexed.map((entry) => entry.item);
}
