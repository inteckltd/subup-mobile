/** Matches `pitchin_service_fee_cents` in supabase/migrations/032_pitch_only_refunds_min_fee.sql. */
export function pitchinServiceFeeCents(priceCents: number): number {
  if (!priceCents || priceCents <= 0) return 0;
  return Math.max(50, Math.round(priceCents * 0.1));
}

export function playerTotalCents(priceCents: number): number {
  return priceCents + pitchinServiceFeeCents(priceCents);
}
