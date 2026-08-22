import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import type { Profile } from '../../types';
import type { ProfileStatsRow, RecentGameRow, SportBreakdownRow } from '../../types/database';
import type { FormResult, ProfileStatsModel, RecentGameModel, SportBreakdownModel } from './types';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

function friendlyError(error: unknown, fallback = GENERIC_ERROR): string {
  recordDiagnosticError('profile', error);
  console.error('[profile]', error);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (message.startsWith('This mobile number is already registered')) return message;
  }
  if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === '23505') {
    return 'That email address is already registered';
  }
  return fallback;
}

export async function fetchMyProfileStats(): Promise<ProfileStatsModel | null> {
  const { data, error } = await supabase.rpc('get_my_profile_stats');
  if (error) throw new Error(friendlyError(error, "Couldn't load your stats."));
  const row = ((data ?? []) as ProfileStatsRow[])[0];
  if (!row) return null;
  return {
    gamesPlayed: Number(row.games_played),
    motmCount: row.motm_count,
    globalMmr: row.global_mmr,
    winRate: row.win_rate == null ? null : Number(row.win_rate),
  };
}

export async function fetchMySportBreakdown(): Promise<SportBreakdownModel[]> {
  const { data, error } = await supabase.rpc('get_my_sport_breakdown');
  if (error) throw new Error(friendlyError(error, "Couldn't load your sports."));
  const rows = ((data ?? []) as SportBreakdownRow[]).map((row) => ({
    sport: row.sport,
    gamesPlayed: Number(row.games_played),
  }));
  if (!rows.some((row) => row.sport === 'football')) {
    return [{ sport: 'football', gamesPlayed: 0 }, ...rows];
  }
  return rows;
}

function formResult(team: 'home' | 'away', scoreHome: number, scoreAway: number): FormResult {
  const mine = team === 'home' ? scoreHome : scoreAway;
  const theirs = team === 'home' ? scoreAway : scoreHome;
  if (mine > theirs) return 'W';
  if (mine < theirs) return 'L';
  return 'D';
}

export async function fetchMyRecentGames(): Promise<RecentGameModel[]> {
  const { data, error } = await supabase.rpc('get_my_recent_games');
  if (error) throw new Error(friendlyError(error, "Couldn't load recent games."));
  return ((data ?? []) as RecentGameRow[])
    .filter((row) => (row.team === 'home' || row.team === 'away') && row.score_home != null && row.score_away != null)
    .map((row) => ({
      id: row.game_id,
      startsAt: row.starts_at,
      sport: row.sport,
      homeColor: row.home_color,
      awayColor: row.away_color,
      scoreHome: row.score_home,
      scoreAway: row.score_away,
      team: row.team as 'home' | 'away',
      result: formResult(row.team as 'home' | 'away', row.score_home as number, row.score_away as number),
    }));
}

export async function uploadAvatar(userId: string, localUri: string): Promise<{ url?: string; error?: string }> {
  try {
    const response = await fetch(localUri);
    const arrayBuffer = await response.arrayBuffer();
    const extension = localUri.split('.').pop()?.toLowerCase().split('?')[0] || 'jpg';
    const contentType = extension === 'png' ? 'image/png' : 'image/jpeg';
    const path = `${userId}/${Date.now()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from('avatars').upload(path, arrayBuffer, { contentType });
    if (uploadError) return { error: friendlyError(uploadError, "Couldn't upload that photo. Please try a different one.") };
    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    return { url: data.publicUrl };
  } catch (error) {
    return { error: friendlyError(error, "Couldn't upload that photo. Please try a different one.") };
  }
}

export async function updateProfileFields(input: {
  fullName: string;
  email: string | null;
  avatarUrl?: string | null;
}): Promise<{ error?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { error: GENERIC_ERROR };

  const patch: Partial<Profile> = {
    full_name: input.fullName,
    email: input.email,
  };
  if (input.avatarUrl !== undefined) patch.avatar_url = input.avatarUrl;

  const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
  if (error) {
    if (error.code === '23505') return { error: 'That email address is already registered' };
    return { error: friendlyError(error) };
  }
  return {};
}

export async function requestMobileChangeOtp(mobile: string): Promise<{ error?: string }> {
  const { data, error } = await supabase.functions.invoke('update-my-mobile', {
    body: { action: 'request', mobile },
  });
  if (error) return { error: friendlyError(error, "Couldn't send a code. Please try again.") };
  const body = data as { ok?: boolean; error?: string } | null;
  if (body && body.ok === false && body.error) return { error: body.error };
  return {};
}

export async function confirmMobileChange(mobile: string, code: string): Promise<{ error?: string }> {
  const { data, error } = await supabase.functions.invoke('update-my-mobile', {
    body: { action: 'confirm', mobile, code },
  });
  if (error) return { error: friendlyError(error, "Couldn't update your mobile number") };
  const body = data as { ok?: boolean; error?: string } | null;
  if (body && body.ok === false && body.error) return { error: body.error };
  return {};
}

export async function changePassword(currentPassword: string, newPassword: string, mobile: string): Promise<{ error?: string }> {
  const { error: signInError } = await supabase.auth.signInWithPassword({ phone: mobile, password: currentPassword });
  if (signInError) return { error: 'Current password is incorrect' };

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    if (/least|characters|weak/i.test(error.message)) return { error: 'Password must be at least 8 characters' };
    return { error: friendlyError(error, "Couldn't update your password") };
  }
  return {};
}

export async function deleteMyAccount(): Promise<{ error?: string }> {
  const { data, error } = await supabase.functions.invoke('delete-my-account');
  if (error) return { error: friendlyError(error, "Couldn't delete your account. Please try again.") };
  const body = data as { ok?: boolean; error?: string } | null;
  if (body && body.ok === false && body.error) return { error: body.error };
  return {};
}
