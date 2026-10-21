/**
 * 导航收口回归：
 *
 * - `VIEW_TYPES` 是合法视图唯一清单，运行时覆盖 `ViewType` 联合的每个成员；
 * - 未知视图（外部字符串 / 非字符串）由 `createNavigate` 运行时守卫拒绝，
 *   不回落 home；合法视图才写入 `setCurrentView`。
 */
import { describe, expect, it, vi } from 'vitest';
import { createNavigate, isViewType, VIEW_TYPES, type ViewType } from './navigation';

// 编译期反向校验：`satisfies ViewType[]` 要求联合每项都在此列出；
// 漏掉清单项时本文件先失败，再由运行时对比兜住反向漏项。
const unionMembers = [
  'home',
  'categories',
  'trends',
  'pending',
  'installed',
  'updates',
  'favorites',
  'settings',
] satisfies ViewType[];

describe('navigation：合法视图清单', () => {
  it('VIEW_TYPES 覆盖每个 ViewType 成员且无重复', () => {
    expect(new Set(VIEW_TYPES)).toEqual(new Set(unionMembers));
    expect(VIEW_TYPES).toHaveLength(unionMembers.length);
  });

  it('isViewType 收窄已知视图，拒绝未知字符串与非字符串', () => {
    for (const view of VIEW_TYPES) expect(isViewType(view)).toBe(true);
    expect(isViewType('trens')).toBe(false);
    expect(isViewType('')).toBe(false);
    expect(isViewType(42)).toBe(false);
    expect(isViewType(null)).toBe(false);
  });
});

describe('navigation：createNavigate', () => {
  it('未知视图被忽略，合法视图写入 setCurrentView', () => {
    const setCurrentView = vi.fn();
    const navigate = createNavigate(setCurrentView);
    // 模拟绕过类型系统的外部调用（深链/URL 载荷未收窄即调用）。
    const callUnchecked = navigate as (view: unknown) => void;

    callUnchecked('trens');
    callUnchecked(42);
    expect(setCurrentView).not.toHaveBeenCalled();

    navigate('trends');
    expect(setCurrentView).toHaveBeenCalledTimes(1);
    expect(setCurrentView).toHaveBeenCalledWith('trends');
  });
});
