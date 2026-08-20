import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** Service-role client for cron / privileged Edge Functions. No session persist. */
export function createServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

type MaybePostgrestError = { code?: string; message?: string } | null;

export function isJwtIssuedInFuture(error: MaybePostgrestError): boolean {
  if (!error) return false;
  return error.code === 'PGRST303' || /JWT issued at future/i.test(error.message ?? '');
}

/**
 * PostgREST rejects JWTs whose `iat` is slightly ahead of the DB clock
 * (Edge vs Postgres skew). Wait and retry once — the next cron tick would
 * otherwise log a 9% error rate with no real failure.
 */
export async function withJwtSkewRetry<T>(
  run: () => PromiseLike<{ data: T; error: MaybePostgrestError }>,
): Promise<{ data: T; error: MaybePostgrestError }> {
  const first = await run();
  if (!isJwtIssuedInFuture(first.error)) return first;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return run();
}
