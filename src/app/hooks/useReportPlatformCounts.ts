import { useLayoutEffect, useRef } from 'react';
import type { PlatformCounts } from '../selectors';

export interface UseReportPlatformCountsOptions {
  /** 是否在 counts 为 null 时也主动上报 null（如分类大厅、Star 列表未加载时回落）；默认 false（跳过 null）。 */
  reportNull?: boolean;
  /** 是否在组件卸载时上报 null 复位槽位；默认 false（保留异步视图已上报的分布）。 */
  resetOnUnmount?: boolean;
}

/**
 * 在浏览器绘制前将视图计算出的侧栏平台分布同步给 App 级状态通道。
 */
export function useReportPlatformCounts(
  counts: PlatformCounts | null,
  onReport: ((counts: PlatformCounts) => void) | undefined,
  options?: { reportNull?: false; resetOnUnmount?: false },
): void;
export function useReportPlatformCounts(
  counts: PlatformCounts | null,
  onReport: ((counts: PlatformCounts | null) => void) | undefined,
  options: UseReportPlatformCountsOptions,
): void;
export function useReportPlatformCounts(
  counts: PlatformCounts | null,
  onReport: ((counts: PlatformCounts | null) => void) | ((counts: PlatformCounts) => void) | undefined,
  options?: UseReportPlatformCountsOptions,
): void {
  const reportRef = useRef(onReport);
  reportRef.current = onReport;

  const reportNull = options?.reportNull ?? false;
  const resetOnUnmount = options?.resetOnUnmount ?? false;

  useLayoutEffect(() => {
    if (counts !== null) {
      reportRef.current?.(counts);
    } else if (reportNull) {
      (reportRef.current as ((c: PlatformCounts | null) => void) | undefined)?.(null);
    }
  }, [counts, reportNull]);

  useLayoutEffect(() => {
    if (!resetOnUnmount) return;
    return () => {
      (reportRef.current as ((c: PlatformCounts | null) => void) | undefined)?.(null);
    };
  }, [resetOnUnmount]);
}
