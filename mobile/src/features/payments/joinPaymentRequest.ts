/**
 * Opt-in for hold-then-capture. The live 1.0.6 app does not send this.
 * Must match HOLD_PAYMENT_FLOW in supabase/functions/_shared/join-payment-flow.ts.
 */
export const HOLD_JOIN_PAYMENT_FLOW = 'hold' as const;

export function joinPaymentRequest(gameId: string): { gameId: string; paymentFlow: typeof HOLD_JOIN_PAYMENT_FLOW } {
  return { gameId, paymentFlow: HOLD_JOIN_PAYMENT_FLOW };
}
