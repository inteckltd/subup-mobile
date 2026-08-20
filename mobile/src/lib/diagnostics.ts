import { captureSentryException } from './sentry';

const RING_SIZE = 20;

export type DiagnosticError = {
  at: string;
  source: string;
  message: string;
};

const ring: DiagnosticError[] = [];

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (message) return message;
  }
  return 'Unknown error';
}

/** Session-only ring of recent client errors for Settings diagnostics. Not persisted. */
export function recordDiagnosticError(source: string, error: unknown): void {
  ring.unshift({
    at: new Date().toISOString(),
    source,
    message: errorMessage(error),
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
