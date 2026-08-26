import { initPaymentSheet, presentPaymentSheet } from '@stripe/stripe-react-native';
import type { QueryClient } from '@tanstack/react-query';

import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import type { GroupPayoutsRow } from '../../types/database';
import type { GroupPayoutsModel } from '../group-details/types';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

function friendlyError(error: unknown, fallback = GENERIC_ERROR): string {
  recordDiagnosticError('payments', error);
  console.error('[payments]', error);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (
      /Pay to join|already joined|no longer open|not a member|full|locked|cannot take payments|waitlist|Set up payouts|Payouts can only|organiser needs to finish Stripe/i
        .test(message)
    ) {
      return message;
    }
  }
  if (error && typeof error === 'object' && 'error' in error && typeof (error as { error: unknown }).error === 'string') {
    return (error as { error: string }).error;
  }
  return fallback;
}

export function mapGroupPayouts(row: GroupPayoutsRow): GroupPayoutsModel {
  return {
    payoutUserId: row.payout_user_id,
    treasurerName: row.treasurer_name?.trim() || 'Group admin',
    chargesEnabled: row.charges_enabled,
    payoutsEnabled: row.payouts_enabled,
    transfersEnabled: !!row.transfers_enabled,
    isSelf: row.is_self,
    isAdmin: row.is_admin,
  };
}

export async function fetchGroupPayouts(groupId: string): Promise<GroupPayoutsModel | null> {
  const { data, error } = await supabase.rpc('get_group_payouts', { p_group_id: groupId });
  if (error) throw new Error(friendlyError(error, "Couldn't load payouts."));
  const row = (Array.isArray(data) ? data[0] : data) as GroupPayoutsRow | null;
  return row ? mapGroupPayouts(row) : null;
}

export async function setGroupPayoutUser(groupId: string, userId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('set_group_payout_user', { p_group_id: groupId, p_user_id: userId });
  if (error) return { error: friendlyError(error, "Couldn't change who receives payouts.") };
  return {};
}

function functionErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return fallback;
}

async function invokeFunctionError(data: unknown, error: unknown, fallback: string): Promise<string> {
  const fromBody = functionErrorMessage(data, '');
  if (fromBody) return fromBody;
  const context = error && typeof error === 'object' && 'context' in error ? (error as { context?: Response }).context : undefined;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error.trim()) return body.error;
    } catch {
      // Response body already consumed or not JSON.
    }
  }
  return friendlyError(error ?? data, fallback);
}

export type ConnectStatus = {
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  transfersEnabled?: boolean;
  detailsSubmitted?: boolean;
  currentlyDue?: string[];
  pastDue?: string[];
  pendingVerification?: string[];
  disabledReason?: string | null;
  linked?: boolean;
  error?: string;
};

export type ConnectNeed = 'ready' | 'needs_documents' | 'needs_info' | 'in_review' | 'incomplete';

const DOCUMENT_REQUIREMENT = /verification\.document|verification\.additional_document|^documents\./i;

export function connectAccountReady(status: Pick<ConnectStatus, 'chargesEnabled' | 'transfersEnabled'>): boolean {
  return !!status.chargesEnabled && !!status.transfersEnabled;
}

function dueRequirementItems(status: ConnectStatus): string[] {
  return [...(status.currentlyDue ?? []), ...(status.pastDue ?? [])];
}

export function classifyConnectStatus(status: ConnectStatus): ConnectNeed {
  if (connectAccountReady(status)) return 'ready';
  if (dueRequirementItems(status).some((item) => DOCUMENT_REQUIREMENT.test(item))) return 'needs_documents';
  if (dueRequirementItems(status).length > 0) return 'needs_info';
  if (status.detailsSubmitted) return 'in_review';
  return 'incomplete';
}

export function connectNeedsMoreSetup(status: ConnectStatus): boolean {
  const kind = classifyConnectStatus(status);
  return kind === 'needs_documents' || kind === 'needs_info' || kind === 'incomplete';
}

export function connectStatusMessage(status: ConnectStatus): string | null {
  switch (classifyConnectStatus(status)) {
    case 'ready':
      return null;
    case 'needs_documents':
      return 'Stripe could not verify the account holder. Open setup again and upload a photo ID.';
    case 'needs_info':
      return 'Stripe needs a bit more information to activate payments.';
    case 'in_review':
      return 'Stripe is reviewing your details. Paid games unlock when charges are enabled.';
    case 'incomplete':
      return status.linked
        ? 'Finish the Stripe form to enable paid games. You can tap Continue setup if you closed it early.'
        : null;
  }
}

export function connectSetupButtonLabel(status: ConnectStatus): string {
  return classifyConnectStatus(status) === 'incomplete' ? 'Set up payouts' : 'Continue setup';
}

export async function syncConnectStatus(): Promise<ConnectStatus> {
  const { data, error } = await supabase.functions.invoke('sync-connect-status', { body: {} });
  if (error || data?.ok === false) {
    return { error: functionErrorMessage(data, friendlyError(error ?? data, "Couldn't refresh payouts status.")) };
  }
  return {
    chargesEnabled: !!data?.chargesEnabled,
    payoutsEnabled: !!data?.payoutsEnabled,
    transfersEnabled: !!data?.transfersEnabled,
    detailsSubmitted: !!data?.detailsSubmitted,
    currentlyDue: Array.isArray(data?.currentlyDue) ? data.currentlyDue : [],
    pastDue: Array.isArray(data?.pastDue) ? data.pastDue : [],
    pendingVerification: Array.isArray(data?.pendingVerification) ? data.pendingVerification : [],
    disabledReason: typeof data?.disabledReason === 'string' ? data.disabledReason : null,
    linked: data?.linked !== false,
  };
}

const CONNECT_POLL_GAPS_MS = [0, 1500, 2000, 3000, 4000, 5000, 7000, 10000];

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stripe often flips charges_enabled a few seconds after the hosted form
 * returns. Stop early if the account still needs the user (ID / extra info).
 */
export async function syncConnectStatusUntilReady(): Promise<ConnectStatus> {
  let last: ConnectStatus = {};
  for (const gap of CONNECT_POLL_GAPS_MS) {
    if (gap) await wait(gap);
    last = await syncConnectStatus();
    if (last.error || connectAccountReady(last)) return last;
    if (gap > 0 && connectNeedsMoreSetup(last)) return last;
  }
  return last;
}

export async function invalidatePayoutsQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: ['group'] });
}

export async function startConnectOnboarding(): Promise<{ url?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke('create-connect-account-link', { body: {} });
  if (error || !data?.url) {
    return { error: await invokeFunctionError(data, error, "Couldn't start payouts setup.") };
  }
  return { url: data.url as string };
}

export async function payToJoinGame(gameId: string): Promise<{ error?: string }> {
  const { data, error } = await supabase.functions.invoke('create-join-payment', { body: { gameId } });
  if (error || data?.ok === false || !data?.clientSecret) {
    await supabase.rpc('release_my_pending_join', { p_game_id: gameId });
    return { error: friendlyError(error ?? data, data?.error ?? "Couldn't start payment.") };
  }

  const init = await initPaymentSheet({
    paymentIntentClientSecret: data.clientSecret as string,
    merchantDisplayName: 'SubUp',
    returnURL: 'subup://stripe-redirect',
    googlePay: { merchantCountryCode: 'GB', testEnv: true, currencyCode: 'GBP' },
    applePay: { merchantCountryCode: 'GB' },
  });
  if (init.error) {
    return { error: init.error.message || "Couldn't open Apple Pay / card pay." };
  }

  const presented = await presentPaymentSheet();
  if (presented.error) {
    if (presented.error.code === 'Canceled') {
      return { error: 'Payment cancelled' };
    }
    return { error: presented.error.message || 'Payment failed.' };
  }

  return {};
}
