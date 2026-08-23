/** Matches `pitchin_service_fee_cents` in supabase/migrations/024_stripe_payments.sql. */
export function pitchinServiceFeeCents(priceCents: number): number {
  if (!priceCents || priceCents <= 0) return 0;
  return Math.max(30, Math.round(priceCents * 0.1));
}

export function playerTotalCents(priceCents: number): number {
  return priceCents + pitchinServiceFeeCents(priceCents);
}
