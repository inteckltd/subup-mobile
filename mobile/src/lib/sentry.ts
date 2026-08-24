import * as Sentry from '@sentry/react-native';

import { env } from './env';

let initialized = false;

const EXPECTED_AUTH_CODES = new Set([
  'invalid_credentials',
  'otp_expired',
  'otp_disabled',
  'user_already_exists',
  'weak_password',
  'over_request_rate_limit',
  'over_email_send_rate_limit',
  'over_sms_send_rate_limit',
  'phone_exists',
  'email_exists',
  'same_password',
]);

const EXPECTED_AUTH_MESSAGE =
  /invalid login credentials|email not confirmed|token has expired|already registered|already exists|signups not allowed|user not found|otp has expired/i;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message ?? '');
  }
  return '';
}

/** Wrong password, expired OTP, and similar user mistakes — keep out of Sentry. */
export function isExpectedClientError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code ?? '');
    if (EXPECTED_AUTH_CODES.has(code)) return true;
  }
  const text = errorText(error);
  if (/AuthRetryableFetchError|network connection was lost/i.test(text)) return true;
  return EXPECTED_AUTH_MESSAGE.test(text);
}

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
      if (isSimulatorAppHang(event) || isRetryableNetworkAuthError(event)) return null;
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
  Sentry.captureException(error, source ? { tags: { source } } : undefined);
}

export { Sentry };
