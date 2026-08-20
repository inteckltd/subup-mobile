import * as Sentry from '@sentry/react-native';

import { env } from './env';

let initialized = false;

export function initSentry() {
  if (initialized || !env.EXPO_PUBLIC_SENTRY_DSN) return;
  Sentry.init({
    dsn: env.EXPO_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.2,
    enableAutoSessionTracking: true,
  });
  initialized = true;
}

export function setSentryUser(userId: string | null) {
  if (!initialized) return;
  if (userId) Sentry.setUser({ id: userId });
  else Sentry.setUser(null);
}

export function captureSentryException(error: unknown, source?: string) {
  if (!initialized) return;
  Sentry.captureException(error, source ? { tags: { source } } : undefined);
}

export { Sentry };
