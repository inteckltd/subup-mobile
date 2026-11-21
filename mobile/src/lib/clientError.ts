/**
 * Turns unknown thrown values (Postgres errors, Keychain errors, plain objects)
 * into a message and fingerprint Sentry can title and group. No I/O.
 */

const GENERIC_WRAPPER =
  /^(calling the ['"].+['"] function has failed\.?|edge function returned a non-2xx status code|something went wrong\.?|unknown error|\[object object\])$/i;

const KEYCHAIN_INTERACTION = /user interaction is not allowed|errsecinteractionnotallowed/i;

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

export type ErrorPiece = {
  name?: string;
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

export type DescribedClientError = {
  name: string;
  message: string;
  code?: string;
  details?: string;
  hint?: string;
  /** iOS Keychain errSecInteractionNotAllowed, including when it is only on `cause`. */
  keychainInteraction: boolean;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value);
}

function isGeneric(message: string): boolean {
  return !message.trim() || GENERIC_WRAPPER.test(message.trim());
}

function pushPiece(pieces: ErrorPiece[], piece: ErrorPiece) {
  if (!piece.message && !piece.code && !piece.details && !piece.hint) return;
  pieces.push({ ...piece, message: piece.message || piece.details || piece.hint || piece.code || '' });
}

function collect(error: unknown, depth: number, pieces: ErrorPiece[]) {
  if (error == null || depth > 6) return;
  if (typeof error === 'string') {
    pushPiece(pieces, { message: error });
    return;
  }
  if (typeof error !== 'object') {
    pushPiece(pieces, { message: String(error) });
    return;
  }

  const record = error as Record<string, unknown>;
  pushPiece(pieces, {
    name: error instanceof Error ? error.name : readString(record.name),
    message: readString(record.message) ?? '',
    code: readCode(record.code),
    details: readString(record.details),
    hint: readString(record.hint),
  });

  if ('cause' in record && record.cause != null && record.cause !== error) {
    collect(record.cause, depth + 1, pieces);
  }

  const nested = record.error;
  if (typeof nested === 'string') pushPiece(pieces, { message: nested });
  else if (nested && nested !== error && typeof nested === 'object') collect(nested, depth + 1, pieces);

  const context = record.context;
  if (typeof context === 'string') pushPiece(pieces, { message: context });
  else if (context && typeof context === 'object' && typeof (context as { json?: unknown }).json !== 'function') {
    collect(context, depth + 1, pieces);
  }
}

function inferName(pieces: ErrorPiece[], message: string, code?: string): string {
  if (KEYCHAIN_INTERACTION.test(message) || pieces.some((piece) => KEYCHAIN_INTERACTION.test(piece.message))) {
    return 'KeychainError';
  }
  if (code && /^[0-9A-Z]{5}$/.test(code)) return 'PostgresError';
  if (code?.startsWith('PGRST')) return 'PostgrestError';
  const named = pieces.find((piece) => piece.name && piece.name !== 'Error');
  return named?.name || 'Error';
}

/** Real message, code, and whether this is the iOS locked-keychain error. */
export function describeClientError(error: unknown): DescribedClientError {
  const pieces: ErrorPiece[] = [];
  collect(error, 0, pieces);
  const specific = [...pieces].reverse().find((piece) => piece.message && !isGeneric(piece.message));
  const chosen = specific ?? pieces.find((piece) => piece.message) ?? { message: 'Unknown error' };
  const code = chosen.code ?? pieces.find((piece) => piece.code)?.code;
  const details = chosen.details ?? pieces.find((piece) => piece.details)?.details;
  const hint = chosen.hint ?? pieces.find((piece) => piece.hint)?.hint;
  const message = (chosen.message || 'Unknown error').slice(0, 500);
  const blob = [message, ...pieces.map((piece) => piece.message)].join('\n');
  return {
    name: inferName(pieces, message, code),
    message,
    code,
    details,
    hint,
    keychainInteraction: KEYCHAIN_INTERACTION.test(blob),
  };
}

/**
 * Drop iOS Keychain "User interaction is not allowed" only while the app is
 * backgrounded or locked. Foreground occurrences stay reportable.
 * Does not change keychain accessibility.
 */
export function shouldDropKeychainNoise(described: DescribedClientError, app: { inForeground: boolean }): boolean {
  return described.keychainInteraction && !app.inForeground;
}

/** Group by source + code + message so different failures are different Sentry issues. */
export function clientErrorFingerprint(source: string | undefined, described: DescribedClientError): string[] {
  const message = described.message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return ['client', source || 'unknown', described.code || described.name, message];
}

/** Wrong password, expired OTP, and similar user mistakes — keep out of Sentry. */
export function isExpectedClientError(error: unknown): boolean {
  if (!error) return false;
  const described = describeClientError(error);
  if (described.code && EXPECTED_AUTH_CODES.has(described.code)) return true;
  const text = described.message;
  if (/AuthRetryableFetchError|network connection was lost/i.test(text)) return true;
  return EXPECTED_AUTH_MESSAGE.test(text);
}
