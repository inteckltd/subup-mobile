import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import type { MyGroupRow, UpcomingGameRow } from '../../types/database';
import type { GameCardModel, GroupCardModel } from './types';

/** A friendly, user-safe message — never leak raw Supabase/Postgres error text. */
const GENERIC_ERROR = 'Something went wrong loading your Home screen. Pull to refresh to try again.';

function friendlyError(error: unknown): Error {
  // Logged so the real cause is visible in the Metro/dev console — the
  // thrown message is what the UI shows, and deliberately never includes
  // raw Supabase/Postgres error text (same pattern as features/auth/api.ts).
  recordDiagnosticError('home', error);
  console.error('[home]', error);
  return new Error(GENERIC_ERROR);
}

function mapGroup(row: MyGroupRow): GroupCardModel {
  return {
    id: row.group_id,
    name: row.name,
    sport: row.sport,
    coverImageUrl: row.cover_image_url,
    role: row.role,
    memberCount: row.member_count,
  };
}

function mapGame(row: UpcomingGameRow): GameCardModel {
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
    status: row.status,
    spotsTaken: row.spots_taken,
    spotsLeft: Math.max(row.max_players - row.spots_taken, 0),
    hasJoined: row.has_joined,
    sport: row.sport,
  };
}

/**
 * Groups the signed-in user belongs to. Calls the `get_my_groups()` RPC
 * (security invoker, RLS-scoped to auth.uid()) rather than selecting from
 * `groups`/`group_members` directly, so member_count is computed
 * server-side under the same RLS the client would otherwise need several
 * round trips to replicate. Never called without a session — see
 * `useMyGroups`'s `enabled: !!session`.
 */
export async function fetchMyGroups(): Promise<GroupCardModel[]> {
  const { data, error } = await supabase.rpc('get_my_groups');
  if (error) throw friendlyError(error);
  return ((data ?? []) as MyGroupRow[]).map(mapGroup);
}

/**
 * Upcoming games (starts_at > now(), status open/full) across every group
 * the user belongs to — not just games they've personally joined, per the
 * product default. See `get_upcoming_games()` in
 * supabase/migrations/003_domain.sql for the exact spots-taken rule.
 */
export async function fetchUpcomingGames(): Promise<GameCardModel[]> {
  const { data, error } = await supabase.rpc('get_upcoming_games');
  if (error) throw friendlyError(error);
  return ((data ?? []) as UpcomingGameRow[]).map(mapGame);
}
