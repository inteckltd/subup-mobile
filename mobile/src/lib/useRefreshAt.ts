import { useEffect, useState } from 'react';

/**
 * Clock that re-renders when the soonest future timestamp is reached.
 * A game screen can flip "locked" or "finished" without ticking every second.
 */
export function useRefreshAt(deadlines: (string | number | null | undefined)[]): Date {
  const [now, setNow] = useState(() => new Date());
  const key = deadlines
    .map((value) => {
      if (value == null || value === '') return '';
      const time = typeof value === 'number' ? value : new Date(value).getTime();
      return Number.isFinite(time) ? String(time) : '';
    })
    .join('|');

  useEffect(() => {
    const current = Date.now();
    const upcoming = key
      .split('|')
      .map((part) => Number(part))
      .filter((time) => Number.isFinite(time) && time > current)
      .sort((a, b) => a - b)[0];
    if (upcoming == null) return;
    const id = setTimeout(() => setNow(new Date()), Math.max(upcoming - current, 0));
    return () => clearTimeout(id);
  }, [key]);

  return now;
}
