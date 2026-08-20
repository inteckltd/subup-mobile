/** Best-effort Sentry reporting for Edge Functions. DSN is the SENTRY_DSN secret. */

export async function captureEdgeError(source: string, error: unknown) {
  console.error(`[${source}]`, error);
  const dsn = Deno.env.get('SENTRY_DSN');
  if (!dsn) return;
  try {
    const Sentry = await import('npm:@sentry/deno');
    Sentry.init({ dsn });
    Sentry.captureException(error, { tags: { function: source } });
    await Sentry.flush(2000);
  } catch (sentryError) {
    console.error(`[${source}] sentry failed`, sentryError);
  }
}
