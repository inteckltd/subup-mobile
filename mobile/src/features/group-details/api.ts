import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import { normalizeUkMobile } from '../../lib/phone';
import type {
  GroupDetailRow,
  GroupGameRow,
  GroupHistoryRow,
  GroupMemberRow,
  GroupPendingInviteRow,
} from '../../types/database';
import type {
  GroupDetailModel,
  GroupGameModel,
  GroupHistoryModel,
  GroupMemberModel,
  GroupPendingInviteModel,
} from './types';

/** A friendly, user-safe message — never leak raw Supabase/Postgres error text (same pattern as features/home/api.ts). */
const GENERIC_ERROR = "Something went wrong loading this group. Pull to refresh to try again.";

function friendlyError(error: unknown): Error {
  recordDiagnosticError('group-details', error);
  console.error('[group-details]', error);
  return new Error(GENERIC_ERROR);
}

function mapGroupDetail(row: GroupDetailRow): GroupDetailModel {
  return {
    id: row.group_id,
    name: row.name,
    sport: row.sport,
    description: row.description,
    coverImageUrl: row.cover_image_url,
    venueName: row.default_venue_name,
    venueAddress: row.default_venue_address,
    defaultWeekday: row.default_weekday,
    defaultTime: row.default_time,
    lockHours: row.lock_hours,
    role: row.role,
    memberCount: row.member_count,
    payoutUserId: row.payout_user_id,
    payoutsReady: row.payouts_ready,
  };
}

function mapGroupMember(row: GroupMemberRow): GroupMemberModel {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.full_name ?? 'Unknown player',
    avatarUrl: row.avatar_url,
    mmr: row.global_mmr ?? 1000,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

function mapGroupGame(row: GroupGameRow): GroupGameModel {
  return {
    id: row.game_id,
    groupId: row.group_id,
    title: row.title,
    startsAt: row.starts_at,
    venueName: row.venue_name,
    venueAddress: row.venue_address,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    priceCents: row.price_cents,
    currency: row.currency,
    status: row.status,
    spotsTaken: row.spots_taken,
    spotsLeft: Math.max(row.max_players - row.spots_taken, 0),
    hasJoined: row.has_joined,
    sport: row.sport,
    previewPlayers: (row.preview_players ?? []).map((player) => ({
      userId: player.user_id,
      name: player.full_name,
      avatarUrl: player.avatar_url,
    })),
  };
}

/**
 * Single-group header info (name/sport/cover/role/member_count) via the
 * `get_group_detail()` RPC — security invoker, scoped to auth.uid()'s
 * membership. Returns null if the caller isn't a member of the group (RPC
 * returns zero rows rather than erroring, since RLS already prevents this
 * from happening in normal navigation).
 */
export async function fetchGroupDetail(groupId: string): Promise<GroupDetailModel | null> {
  const { data, error } = await supabase.rpc('get_group_detail', { p_group_id: groupId });
  if (error) throw friendlyError(error);
  const rows = (data ?? []) as GroupDetailRow[];
  return rows[0] ? mapGroupDetail(rows[0]) : null;
}

/**
 * The group's roster via `get_group_members()` — name/avatar/MMR only so
 * mates cannot read each other's mobile or email.
 */
export async function fetchGroupMembers(groupId: string): Promise<GroupMemberModel[]> {
  const { data, error } = await supabase.rpc('get_group_members', { p_group_id: groupId });
  if (error) throw friendlyError(error);
  return ((data ?? []) as GroupMemberRow[]).map(mapGroupMember);
}

/**
 * Upcoming games (starts_at > now(), status open/full) scoped to this one
 * group via `get_group_upcoming_games()` — same shape/rules as Home's
 * `get_upcoming_games()` plus a small `preview_players` avatar-stack list.
 */
export async function fetchGroupUpcomingGames(groupId: string): Promise<GroupGameModel[]> {
  const { data, error } = await supabase.rpc('get_group_upcoming_games', { p_group_id: groupId });
  if (error) throw friendlyError(error);
  return ((data ?? []) as GroupGameRow[]).map(mapGroupGame);
}

const MUTATION_MESSAGES = [
  'This user does not exist',
  'This person is already a member of the group',
  'This person has already been invited',
  'Only group admins can invite members',
  'Only group admins can edit this group',
  'Only group admins can promote members',
  'Only group admins can remove members',
  'Only group admins can cancel invites',
  'Promote another admin before leaving or removing the last admin',
  'Use leave group to remove yourself',
  'You are not a member of this group',
  'That person is not a member of this group',
  'You are already an admin',
  'Too many attempts',
];

function mutationError(error: unknown, fallback: string): string {
  recordDiagnosticError('group-details', error);
  console.error('[group-details]', error);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (MUTATION_MESSAGES.some((known) => message.startsWith(known))) return message;
  }
  return fallback;
}

export async function fetchGroupPendingInvites(groupId: string): Promise<GroupPendingInviteModel[]> {
  const { data, error } = await supabase.rpc('get_group_pending_invites', { p_group_id: groupId });
  if (error) throw friendlyError(error);
  return ((data ?? []) as GroupPendingInviteRow[]).map((row) => ({
    id: row.invite_id,
    userId: row.invited_user_id,
    name: row.awaiting_signup ? 'Waiting to download SubUp' : (row.full_name ?? 'Unknown player'),
    avatarUrl: row.avatar_url,
    awaitingSignup: row.awaiting_signup,
    createdAt: row.created_at,
  }));
}

export async function fetchGroupHistory(groupId: string): Promise<GroupHistoryModel[]> {
  const { data, error } = await supabase.rpc('get_group_history', { p_group_id: groupId });
  if (error) throw friendlyError(error);
  return ((data ?? []) as GroupHistoryRow[]).map((row) => ({
    id: row.game_id,
    title: row.title,
    startsAt: row.starts_at,
    homeColor: row.home_color,
    awayColor: row.away_color,
    scoreHome: row.score_home,
    scoreAway: row.score_away,
    playedCount: Number(row.played_count),
  }));
}

export async function inviteGroupMember(
  groupId: string,
  mobileInput: string,
  options?: { skipSms?: boolean },
): Promise<{ inviteId?: string; existingUser?: boolean; error?: string }> {
  const mobile = normalizeUkMobile(mobileInput);
  if (!mobile) return { error: 'Enter a valid UK mobile number' };

  const { data, error } = await supabase.rpc('invite_group_member', { p_group_id: groupId, p_mobile: mobile });
  if (error) return { error: mutationError(error, "Couldn't send that invite.") };

  const inviteId = (Array.isArray(data) ? data[0] : data) as string | null;
  let existingUser = false;
  if (inviteId) {
    const { data: invite } = await supabase
      .from('group_invites')
      .select('invited_user_id')
      .eq('id', inviteId)
      .maybeSingle();
    existingUser = Boolean(invite?.invited_user_id);
    try {
      await supabase.functions.invoke('notify-group-invite', {
        body: { inviteId, skipSms: options?.skipSms === true },
      });
    } catch (pushError) {
      console.error('[group-details] notify-group-invite failed', pushError);
    }
  }
  return { inviteId: inviteId ?? undefined, existingUser };
}

export async function leaveGroup(groupId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('leave_group', { p_group_id: groupId });
  if (error) return { error: mutationError(error, "Couldn't leave this group.") };
  return {};
}

export async function promoteGroupAdmin(groupId: string, userId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('promote_group_admin', { p_group_id: groupId, p_user_id: userId });
  if (error) return { error: mutationError(error, "Couldn't promote this member.") };
  return {};
}

export async function kickGroupMember(groupId: string, userId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('kick_group_member', { p_group_id: groupId, p_user_id: userId });
  if (error) return { error: mutationError(error, "Couldn't remove this member.") };
  return {};
}

export async function cancelGroupInvite(inviteId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('cancel_group_invite', { p_invite_id: inviteId });
  if (error) return { error: mutationError(error, "Couldn't cancel this invite.") };
  return {};
}
