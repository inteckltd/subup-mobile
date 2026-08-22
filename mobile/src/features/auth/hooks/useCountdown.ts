import { useCallback, useEffect, useState } from 'react';

export function useCountdown(seconds: number) {
  const [remaining, setRemaining] = useState(0);

  const start = useCallback(() => {
    setRemaining(seconds);
  }, [seconds]);

  useEffect(() => {
    if (remaining <= 0) return;
    const id = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(id);
  }, [remaining]);

  return { remaining, start, isRunning: remaining > 0 };
}
