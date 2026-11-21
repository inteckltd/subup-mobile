import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { formatCountdown } from '../../../lib/format';

type CountdownTextProps = {
  target: string;
  className?: string;
  /** Shown in the same text style, before the countdown. */
  prefix?: string;
};

const HOUR_MS = 60 * 60 * 1000;

function delayUntilNextTick(target: string): number {
  const msLeft = new Date(target).getTime() - Date.now();
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 60_000;
  if (msLeft <= HOUR_MS) return 1000;
  const intoMinute = Date.now() % 60_000;
  const untilMinute = intoMinute === 0 ? 60_000 : 60_000 - intoMinute;
  return Math.min(untilMinute, msLeft - HOUR_MS);
}

/**
 * Live countdown that ticks on its own. Once an hour or more is left it
 * updates each minute. Inside the last hour it shows seconds.
 */
export function CountdownText({ target, className, prefix }: CountdownTextProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, delayUntilNextTick(target));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [target]);

  return (
    <Text className={className}>
      {prefix}
      {formatCountdown(target, now)}
    </Text>
  );
}
