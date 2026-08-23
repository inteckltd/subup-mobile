import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import type { CreatableGroupRow, Game, GameDetailRow, GamePlayerRow, MmrEventRow, MotmBallotRow } from '../../types/database';
import { combineDateAndTime, poundsToCents, type CreateGameFormValues } from './schemas';
import type { CreatableGroupModel, GameDetailModel, GamePlayerModel, MotmBallotModel } from './types';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

/**
 * Messages this feature's own RPCs (`create_game`/`join_game`/`leave_game`
 * in 006_create_game_push.sql) deliberately raise as friendly, user-safe
 * text — same allow-list pattern as `features/auth/api.ts`'s
 * `friendlyError`, just scoped to the exact strings this feature's own SQL
 * raises (never a generic regex over arbitrary Postgres/PostgREST errors).
 */
const KNOWN_MESSAGES = [
  'Only group admins can create games',
  'Group not found',
  'Min players must be at least 1',
  'Max players must be at least 1 more than the minimum players',
  'Price cannot be negative',
  'Game must start in the future',
  'Kickoff must be at least',
  'Duration must be between 1 minute and 6 hours',
  'Home and away colours must be different',
  'Unsupported team colour',
  'Game not found',
  "You are not a member of this game's group",
  'This game is no longer open',
  'You have already joined this game',
  'This game is full',
  'Teams have already been picked for this game',
  'Joining is locked within',
  'Only group admins can move players',
  'Teams have not been picked yet',
  'This game can no longer be changed',
  'Team must be home or away',
  'You have not joined this game',
  'Only group admins can enter a score',
  'A score has already been entered for this game',
  'This game cannot be scored',
  'You can enter the score once the game has finished',
  'Scores cannot be negative',
  'You cannot vote for yourself',
  'Voting opens after the score is entered',
  'MOTM voting has closed',
  'Only players in this game can vote',
  'That player is not in this game',
  'Only group admins can edit games',
  'Only group admins can cancel games',
  'Editing is locked within',
  'Kickoff has already passed',
  'Max players cannot be below',
  'Set up payouts before creating a paid game',
  'Price cannot change after someone has paid',
  'Pay to join this game',
  'This group cannot take payments yet',
  'This game is free',
  'You are on the waitlist',
  'Payouts can only go to a group admin',
  'Only group admins can change payouts',
  "Couldn't refund this payment",
  "Couldn't leave this game",
  "You can't leave within the lock window",
];

/** A friendly, user-safe message — never leak raw Supabase/Postgres error text (same pattern as features/auth/api.ts). */
function friendlyError(error: unknown, fallback = GENERIC_ERROR): string {
  recordDiagnosticError('games', error);
  console.error('[games]', error);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (KNOWN_MESSAGES.some((known) => message.startsWith(known)) || /can't leave within \d+ hours/i.test(message)) {
      return message;
    }
  }
  return fallback;
}

/** Parses a Postgres `time` string (`"HH:MM:SS"`) into an hour, ignoring seconds. Returns null for anything unparseable. */
function parseHour(time: string | null): number | null {
  const hour = time ? Number(time.slice(0, 2)) : NaN;
  return Number.isInteger(hour) ? hour : null;
}

/** Parses a Postgres `time` string (`"HH:MM:SS"`) into a minute. Returns null for anything unparseable. */
function parseMinute(time: string | null): number | null {
  const minute = time ? Number(time.slice(3, 5)) : NaN;
  return Number.isInteger(minute) ? minute : null;
}

function mapCreatableGroup(row: CreatableGroupRow): CreatableGroupModel | null {
  if (!row.group) return null;
  return {
    id: row.group.id,
    name: row.group.name,
    defaultVenueName: row.group.default_venue_name,
    defaultVenueAddress: row.group.default_venue_address,
    defaultWeekday: row.group.default_weekday,
    defaultHour: parseHour(row.group.default_time),
    defaultMinute: parseMinute(row.group.default_time),
    lockHours: row.group.lock_hours === 48 || row.group.lock_hours === 72 ? row.group.lock_hours : 24,
  };
}

function mapGameDetail(row: GameDetailRow): GameDetailModel {
  return {
    id: row.game_id,
    groupId: row.group_id,
    groupName: row.group_name,
    title: row.title,
    startsAt: row.starts_at,
    venueName: row.venue_name,
    venueAddress: row.venue_address,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    priceCents: row.price_cents,
    currency: row.currency,
    notes: row.notes,
    status: row.status,
    allowWaitlist: row.allow_waitlist,
    allowCash: row.allow_cash,
    cancelIfMinNotMetHours: row.cancel_if_min_not_met_hours,
    durationMinutes: row.duration_minutes,
    homeColor: row.home_color,
    awayColor: row.away_color,
    scoreHome: row.score_home,
    scoreAway: row.score_away,
    scoreNotes: row.score_notes,
    createdBy: row.created_by,
    organizerName: row.organizer_name,
    scoredAt: row.scored_at,
    motmUserId: row.motm_user_id,
    motmName: row.motm_name,
    motmClosedAt: row.motm_closed_at,
    myMotmVoteUserId: row.my_motm_vote_user_id,
    teamsPickedAt: row.teams_picked_at,
    spotsTaken: row.spots_taken,
    spotsPaid: row.spots_paid,
    waitlistCount: row.waitlist_count,
    hasJoined: row.has_joined,
    isWaitlisted: row.is_waitlisted,
    isAdmin: row.is_admin,
    myPaymentStatus: row.my_payment_status,
    myPendingExpiresAt: row.my_pending_expires_at,
    feeCents: row.fee_cents,
    totalCents: row.total_cents,
    payoutsReady: row.payouts_ready,
  };
}

function mapGamePlayer(row: GamePlayerRow, mmrDelta: number | null): GamePlayerModel {
  const userId = row.user_id;
  return {
    id: row.id,
    userId,
    name: row.full_name ?? (userId ? 'Unknown player' : 'Deleted user'),
    avatarUrl: row.avatar_url ?? null,
    mmr: row.global_mmr ?? 1000,
    mmrDelta,
    paymentStatus: row.payment_status,
    isWaitlisted: row.is_waitlisted,
    joinedAt: row.joined_at,
    team: row.team === 'home' || row.team === 'away' ? row.team : null,
  };
}

/**
 * Groups the caller can create a game in — a direct `group_members` select
 * embedding `groups` (same pattern as `fetchGroupMembers`), filtered to
 * this user's own `role = 'admin'` rows. Pulls each group's default venue
 * and recurring weekday/time too, so the Create Game form can prefill
 * venue, date and time the moment a group is picked from the dropdown,
 * not just when arriving via a `groupId` param.
 */
export async function fetchCreatableGroups(userId: string): Promise<CreatableGroupModel[]> {
  const { data, error } = await supabase
    .from('group_members')
    .select('role, group:groups(id, name, default_venue_name, default_venue_address, default_weekday, default_time, lock_hours)')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .order('joined_at', { ascending: true });
  if (error) throw new Error(friendlyError(error, "Couldn't load your groups. Pull to refresh to try again."));
  return ((data ?? []) as unknown as CreatableGroupRow[])
    .map(mapCreatableGroup)
    .filter((group): group is CreatableGroupModel => group !== null);
}

/**
 * Creates a game via the `create_game` RPC (admin-checked, validated,
 * transactional in-app notification fan-out — see
 * supabase/migrations/006_create_game_push.sql and PLAN_CREATE_GAME.md
 * "create_game — SECURITY DEFINER RPC"), then best-effort invokes the
 * `notify-game-created` Edge Function for push. The Edge Function call is
 * deliberately never allowed to fail this function — game creation has
 * already succeeded by that point regardless of whether push is configured.
 */
export async function createGame(values: CreateGameFormValues): Promise<{ id?: string; error?: string }> {
  const startsAt = combineDateAndTime(values.date, values.time);

  const { data, error } = await supabase.rpc('create_game', {
    p_group_id: values.groupId,
    p_title: values.title?.trim() || null,
    p_starts_at: startsAt.toISOString(),
    p_venue_name: values.venueName.trim(),
    p_venue_address: values.venueAddress?.trim() || null,
    p_min_players: values.minPlayers,
    p_max_players: values.maxPlayers,
    p_price_cents: poundsToCents(values.pricePounds),
    p_allow_waitlist: values.allowWaitlist,
    p_allow_cash: false,
    p_duration_minutes: values.durationMinutes,
    p_home_color: values.homeColor,
    p_away_color: values.awayColor,
  });

  if (error) return { error: friendlyError(error, "Couldn't create this game. Please try again.") };

  const game = (Array.isArray(data) ? data[0] : data) as Game | null;
  if (!game) return { error: GENERIC_ERROR };

  try {
    await supabase.functions.invoke('notify-game-created', { body: { gameId: game.id } });
  } catch (pushError) {
    // Best effort only — see the doc comment above. Never surfaced to the user.
    console.error('[games] notify-game-created invoke failed', pushError);
  }

  return { id: game.id };
}

export async function updateGame(gameId: string, values: CreateGameFormValues): Promise<{ error?: string }> {
  const startsAt = combineDateAndTime(values.date, values.time);

  const { error } = await supabase.rpc('update_game', {
    p_game_id: gameId,
    p_title: values.title?.trim() || null,
    p_starts_at: startsAt.toISOString(),
    p_venue_name: values.venueName.trim(),
    p_venue_address: values.venueAddress?.trim() || null,
    p_min_players: values.minPlayers,
    p_max_players: values.maxPlayers,
    p_price_cents: poundsToCents(values.pricePounds),
    p_allow_waitlist: values.allowWaitlist,
    p_allow_cash: false,
    p_duration_minutes: values.durationMinutes,
    p_home_color: values.homeColor,
    p_away_color: values.awayColor,
  });

  if (error) return { error: friendlyError(error, "Couldn't update this game. Please try again.") };

  try {
    await supabase.functions.invoke('notify-game-lifecycle', { body: { gameId, type: 'game_updated' } });
  } catch (pushError) {
    console.error('[games] notify-game-lifecycle invoke failed', pushError);
  }

  return {};
}

export async function cancelGame(gameId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('cancel_game', { p_game_id: gameId });
  if (error) return { error: friendlyError(error, "Couldn't cancel this game. Please try again.") };

  try {
    await supabase.functions.invoke('refund-game-payments', { body: { gameId } });
  } catch (refundError) {
    recordDiagnosticError('games', refundError);
    console.error('[games] refund-game-payments invoke failed', refundError);
  }

  try {
    await supabase.functions.invoke('notify-game-lifecycle', { body: { gameId, type: 'game_cancelled' } });
  } catch (pushError) {
    console.error('[games] notify-game-lifecycle invoke failed', pushError);
  }

  return {};
}

/**
 * Single-game detail for Game Details, via the `get_game_detail()` RPC —
 * security invoker, scoped to the caller's group membership. Returns null
 * if the caller isn't a member of the game's group (RPC returns zero rows
 * rather than erroring).
 */
export async function fetchGameDetail(gameId: string): Promise<GameDetailModel | null> {
  const { data, error } = await supabase.rpc('get_game_detail', { p_game_id: gameId });
  if (error) throw new Error(friendlyError(error, "Couldn't load this game. Pull to refresh to try again."));
  const rows = (data ?? []) as GameDetailRow[];
  return rows[0] ? mapGameDetail(rows[0]) : null;
}

/**
 * The game's player lobby via `get_game_lobby_players()` — name/avatar/MMR
 * only. Waitlisted players sort after confirmed ones.
 */
export async function fetchGamePlayers(gameId: string): Promise<GamePlayerModel[]> {
  const [playersResult, eventsResult, gameResult] = await Promise.all([
    supabase.rpc('get_game_lobby_players', { p_game_id: gameId }),
    supabase.from('mmr_events').select('user_id, delta').eq('game_id', gameId),
    supabase.from('games').select('motm_closed_at').eq('id', gameId).maybeSingle(),
  ]);
  if (playersResult.error) {
    throw new Error(friendlyError(playersResult.error, "Couldn't load this game's players."));
  }
  if (eventsResult.error) {
    throw new Error(friendlyError(eventsResult.error, "Couldn't load this game's players."));
  }

  const totals = new Map<string, number>();
  for (const event of (eventsResult.data ?? []) as MmrEventRow[]) {
    totals.set(event.user_id, (totals.get(event.user_id) ?? 0) + event.delta);
  }
  const motmClosed = !!gameResult.data?.motm_closed_at || totals.size > 0;

  return ((playersResult.data ?? []) as GamePlayerRow[]).map((row) => {
    const userId = row.user_id;
    const mmrDelta = row.is_waitlisted || !motmClosed || !userId ? null : (totals.get(userId) ?? 0);
    return mapGamePlayer(row, mmrDelta);
  });
}

/** Race-safe join via the `join_game` RPC — see PLAN_CREATE_GAME.md "join_game / leave_game". */
export async function joinGame(gameId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('join_game', { p_game_id: gameId });
  if (error) return { error: friendlyError(error, "Couldn't join this game. Please try again.") };
  return {};
}

/** Race-safe leave via the `leave_game` RPC — blocked inside the game's auto-cancel window for confirmed players. Promotes the earliest waitlisted player when a confirmed spot frees; push for that player is best-effort. */
export async function leaveGame(gameId: string, options?: { paid?: boolean }): Promise<{ error?: string }> {
  let promotedUserId: string | null = null;

  if (options?.paid) {
    const { data, error } = await supabase.functions.invoke('leave-paid-game', { body: { gameId } });
    if (error || data?.ok === false) {
      return { error: friendlyError(error ?? data, data?.error ?? "Couldn't leave this game. Please try again.") };
    }
    promotedUserId = typeof data?.promotedUserId === 'string' ? data.promotedUserId : null;
  } else {
    const { data, error } = await supabase.rpc('leave_game', { p_game_id: gameId });
    if (error) return { error: friendlyError(error, "Couldn't leave this game. Please try again.") };
    promotedUserId = typeof data === 'string' ? data : null;
  }

  if (promotedUserId) {
    try {
      await supabase.functions.invoke('notify-waitlist-promoted', {
        body: { gameId },
      });
    } catch (pushError) {
      recordDiagnosticError('games', pushError);
      console.error('[games] notify-waitlist-promoted invoke failed', pushError);
    }
  }

  return {};
}

/**
 * Submits a game's final score via the `submit_game_score` RPC (admin-only,
 * one-shot, only once the game has finished — see
 * supabase/migrations/009_game_duration_score.sql), then best-effort
 * invokes the `notify-score-updated` Edge Function for push, same
 * fire-and-forget pattern as `createGame()`'s `notify-game-created` call.
 */
export async function submitGameScore(
  gameId: string,
  scoreHome: number,
  scoreAway: number,
  scoreNotes: string | null,
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('submit_game_score', {
    p_game_id: gameId,
    p_score_home: scoreHome,
    p_score_away: scoreAway,
    p_score_notes: scoreNotes?.trim() || null,
  });

  if (error) return { error: friendlyError(error, "Couldn't save this score. Please try again.") };

  try {
    await supabase.functions.invoke('notify-score-updated', { body: { gameId } });
  } catch (pushError) {
    // Best effort only — see the doc comment above. Never surfaced to the user.
    console.error('[games] notify-score-updated invoke failed', pushError);
  }

  return {};
}

export async function fetchMotmBallot(gameId: string): Promise<MotmBallotModel | null> {
  const { data, error } = await supabase.rpc('get_motm_ballot', { p_game_id: gameId });
  if (error) throw new Error(friendlyError(error, "Couldn't load MOTM voting."));
  const rows = (data ?? []) as MotmBallotRow[];
  const first = rows[0];
  if (!first) return null;
  return {
    gameId: first.game_id,
    title: first.title,
    groupName: first.group_name,
    scoredAt: first.scored_at,
    closesAt: first.closes_at,
    isOpen: first.is_open,
    myVoteUserId: first.my_vote_user_id,
    motmUserId: first.motm_user_id,
    motmName: first.motm_name,
    candidates: rows
      .filter((row) => row.candidate_user_id)
      .map((row) => ({
        userId: row.candidate_user_id as string,
        name: row.candidate_name ?? 'Unknown player',
        avatarUrl: row.candidate_avatar_url,
        mmr: row.candidate_mmr ?? 1000,
      })),
  };
}

export async function voteMotm(gameId: string, votedForId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('vote_motm', { p_game_id: gameId, p_voted_for_id: votedForId });
  if (error) return { error: friendlyError(error, "Couldn't submit your vote.") };
  return {};
}

export async function moveGamePlayerTeam(
  gameId: string,
  userId: string,
  team: 'home' | 'away',
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('move_game_player_team', {
    p_game_id: gameId,
    p_user_id: userId,
    p_team: team,
  });
  if (error) return { error: friendlyError(error, "Couldn't move this player.") };
  return {};
}
