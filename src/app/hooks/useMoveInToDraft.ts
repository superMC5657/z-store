import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppSummary } from '../../types';
import { moveInToDraft } from '../../services/custom';
import { normalizeId } from '../../services/normalizeId';
import { notifyToast } from '../../useToasts';

/** 富卡「移入收录」共享动作 Hook：按归一 id 防重入并统一弹出提示。 */
export function useMoveInToDraft() {
  const { t } = useTranslation();
  const [movingIds, setMovingIds] = useState<Set<string>>(() => new Set<string>());
  const movingRef = useRef<Set<string>>(new Set<string>());

  const handleMoveIn = useCallback(
    async (app: AppSummary) => {
      const key = normalizeId(app.id) || app.id;
      if (!key || movingRef.current.has(key)) return;
      movingRef.current.add(key);
      setMovingIds((prev) => new Set(prev).add(key));
      try {
        const res = await moveInToDraft(app);
        if (!res.ok) {
          notifyToast(
            t('custom.move_in_failed', {
              error: res.error ?? '',
            }),
            'error',
          );
          return;
        }
        notifyToast(t('custom.moved_in', { id: res.id }), 'success');
      } finally {
        movingRef.current.delete(key);
        setMovingIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [t],
  );

  const isMovingIn = useCallback(
    (id: string): boolean => movingIds.has(normalizeId(id) || id),
    [movingIds],
  );

  return { isMovingIn, handleMoveIn };
}
