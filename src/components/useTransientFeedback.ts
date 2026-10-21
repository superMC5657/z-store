import { useCallback, useEffect, useRef, useState } from 'react';

export interface TransientFeedback {
  text: string | null;
  isError: boolean;
  show: (text: string, error: boolean) => void;
}

/**
 * 行内瞬时反馈：`show` 写入文案并在 `durationMs` 后清空。
 * 定时器在卸载与新 `show` 时清除，卸载后不再 `setState`。
 */
export function useTransientFeedback(durationMs = 5000): TransientFeedback {
  const [text, setText] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const show = useCallback(
    (next: string, error: boolean) => {
      clearTimer();
      setText(next);
      setIsError(error);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setText(null);
      }, durationMs);
    },
    [durationMs],
  );

  return { text, isError, show };
}
