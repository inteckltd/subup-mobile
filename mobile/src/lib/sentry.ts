import * as Sentry from '@sentry/react-native';
import { AppState } from 'react-native';

import {
  clientErrorFingerprint,
  describeClientError,
  isExpectedClientError,
  shouldDropKeychainNoise,
} from './clientError';
import { env } from './env';

let initialized = false;

function exceptionText(event: Sentry.ErrorEvent): string {
  return (event.exception?.values ?? [])
    .map((value) => `${value.type ?? ''} ${value.value ?? ''}`)
    .join(' ');
}

function isSimulatorAppHang(event: Sentry.ErrorEvent): boolean {
  const simulator = event.contexts?.device && 'simulator' in event.contexts.device
    ? Boolean((event.contexts.device as { simulator?: boolean }).simulator)
    : false;
  if (!simulator) return false;
  return /app hang/i.test(exceptionText(event));
}

/** Transient auth fetch failures (dropped Wi-Fi, etc.) — not actionable. */
function isRetryableNetworkAuthError(event: Sentry.ErrorEvent): boolean {
  const text = exceptionText(event);
  return /AuthRetryableFetchError/i.test(text) || /network connection was lost/i.test(text);
}

/**
 * Keychain "User interaction is not allowed" while the app is not in front.
 * Uses Sentry's own foreground flag when it has one, otherwise AppState.
 * Does not change keychain accessibility or session storage.
 */
function isBackgroundKeychainEvent(event: Sentry.ErrorEvent): boolean {
  if (!/user interaction is not allowed|errsecinteractionnotallowed/i.test(exceptionText(event))) return false;
  const app = event.contexts?.app as { in_foreground?: boolean } | undefined;
  if (typeof app?.in_foreground === 'boolean') return app.in_foreground === false;
  return AppState.currentState !== 'active';
}

function appInForeground(): boolean {
  return AppState.currentState === 'active';
}

export function initSentry() {
  if (initialized || !env.EXPO_PUBLIC_SENTRY_DSN) return;
  Sentry.init({
    dsn: env.EXPO_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.2,
    enableAutoSessionTracking: true,
    enableAppHangTracking: !__DEV__,
    appHangTimeoutInterval: 5,
    ignoreErrors: ['Invalid login credentials', 'AuthRetryableFetchError'],
    beforeSend(event) {
      if (isSimulatorAppHang(event) || isRetryableNetworkAuthError(event) || isBackgroundKeychainEvent(event)) {
        return null;
      }
      return event;
    },
  });
  initialized = true;
}

export function setSentryUser(userId: string | null) {
  if (!initialized) return;
  if (userId) Sentry.setUser({ id: userId });
  else Sentry.setUser(null);
}

export function captureSentryException(error: unknown, source?: string) {
  if (!initialized || isExpectedClientError(error)) return;
  const described = describeClientError(error);
  if (shouldDropKeychainNoise(described, { inForeground: appInForeground() })) return;

  const exception = new Error(described.message);
  exception.name = described.name;
  if (error instanceof Error && error.stack) exception.stack = error.stack;
  if (error instanceof Error) exception.cause = error;

  Sentry.captureException(exception, {
    tags: {
      ...(source ? { source } : {}),
      ...(described.code ? { error_code: described.code } : {}),
    },
    fingerprint: clientErrorFingerprint(source, described),
    extra: {
      underlying_message: described.message,
      ...(described.details ? { details: described.details } : {}),
      ...(described.hint ? { hint: described.hint } : {}),
    },
  });
}

export { isExpectedClientError, Sentry };
