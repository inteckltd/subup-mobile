import { AppState } from 'react-native';

import { describeClientError, shouldDropKeychainNoise } from './clientError';
import { captureSentryException } from './sentry';

const RING_SIZE = 20;

export type DiagnosticError = {
  at: string;
  source: string;
  message: string;
};

const ring: DiagnosticError[] = [];

/** Session-only ring of recent client errors for Settings diagnostics. Not persisted. */
export function recordDiagnosticError(source: string, error: unknown): void {
  const described = describeClientError(error);
  // Locked-phone keychain errors are expected. Don't crowd out real failures.
  if (shouldDropKeychainNoise(described, { inForeground: AppState.currentState === 'active' })) return;
  ring.unshift({
    at: new Date().toISOString(),
    source,
    message: described.message || 'Unknown error',
  });
  if (ring.length > RING_SIZE) ring.length = RING_SIZE;
  captureSentryException(error, source);
}

export function getDiagnosticErrors(): DiagnosticError[] {
  return [...ring];
}

export function clearDiagnosticErrors(): void {
  ring.length = 0;
}
