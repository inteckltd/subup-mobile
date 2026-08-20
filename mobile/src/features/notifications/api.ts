import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import type { NotificationRow } from '../../types/database';
import type { NotificationModel } from './types';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

const KNOWN = [
  'This user does not exist',
  'This person is already a member of the group',
  'This person has already been invited',
  'Only group admins can invite members',
  'This invite is not for you',
  'This invite is no longer pending',
  'Invite not found',
];

function friendlyError(error: unknown, fallback = GENERIC_ERROR): string {
  recordDiagnosticError('notifications', error);
  console.error('[notifications]', error);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (KNOWN.some((known) => message.startsWith(known))) return message;
  }
  return fallback;
}

export async function fetchMyNotifications(): Promise<NotificationModel[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, user_id, type, title, body, data, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(friendlyError(error, "Couldn't load notifications."));
  return ((data ?? []) as NotificationRow[]).map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data,
    readAt: row.read_at,
    createdAt: row.created_at,
  }));
}

export async function acceptGroupInvite(inviteId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('accept_group_invite', { p_invite_id: inviteId });
  if (error) return { error: friendlyError(error) };
  return {};
}

export async function declineGroupInvite(inviteId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('decline_group_invite', { p_invite_id: inviteId });
  if (error) return { error: friendlyError(error) };
  return {};
}
