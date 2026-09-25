/**
 * Phase 2 domain types — mirrors supabase/migrations/003_domain.sql.
 *
 * These are hand-written (no `supabase gen types` in this repo yet) — keep
 * in sync with the migration when the schema changes.
 */

export type SportType = 'football' | 'rugby' | 'padel' | 'basketball' | 'netball' | 'cricket' | 'hockey' | 'other';

export type GroupMemberRole = 'admin' | 'member';

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';

export type GameStatus = 'draft' | 'open' | 'full' | 'cancelled' | 'completed';

export type PaymentStatus = 'unpaid' | 'pending' | 'paid' | 'cash' | 'waived' | 'refunded';

export type LockHours = 24 | 48 | 72;

export type NotificationType =
  | 'group_invite'
  | 'game_created'
  | 'game_updated'
  | 'game_cancelled'
  | 'game_reminder'
  | 'payment'
  | 'score_posted'
  | 'score_reminder'
  | 'motm_reminder'
  | 'waitlist_promoted'
  | 'system';

export type Group = {
  id: string;
  name: string;
  sport: SportType;
  description: string | null;
  cover_image_url: string | null;
  default_venue_name: string | null;
  default_venue_address: string | null;
  default_weekday: number | null;
  default_time: string | null;
  lock_hours: LockHours;
  payout_user_id: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type GroupMember = {
  id: string;
  group_id: string;
  user_id: string;
  role: GroupMemberRole;
  joined_at: string;
};

export type GroupInvite = {
  id: string;
  group_id: string;
  invited_by: string;
  mobile: string | null;
  email: string | null;
  invited_user_id: string | null;
  status: InviteStatus;
  sms_sent_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type Game = {
  id: string;
  group_id: string;
  title: string | null;
  starts_at: string;
  venue_name: string | null;
  venue_address: string | null;
  min_players: number;
  max_players: number;
  price_cents: number;
  currency: string;
  notes: string | null;
  status: GameStatus;
  allow_waitlist: boolean;
  allow_cash: boolean;
  cancel_if_min_not_met_hours: number;
  duration_minutes: number;
  home_color: string;
  away_color: string;
  created_by: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  score_home: number | null;
  score_away: number | null;
  score_notes: string | null;
  score_reminder_sent_at: string | null;
  scored_by: string | null;
  scored_at: string | null;
  treasurer_payout_id: string | null;
  treasurer_paid_out_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GamePlayer = {
  id: string;
  game_id: string;
  user_id: string;
  payment_status: PaymentStatus;
  is_waitlisted: boolean;
  joined_at: string;
  marked_cash_by: string | null;
};

export type NotificationRow = {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

/** Raw row shape returned by the `get_my_groups()` RPC — see 003_domain.sql. */
export type MyGroupRow = {
  group_id: string;
  name: string;
  sport: SportType;
  cover_image_url: string | null;
  role: GroupMemberRole;
  member_count: number;
};

/** Raw row shape returned by the `get_upcoming_games()` RPC — see 003_domain.sql. */
export type UpcomingGameRow = {
  game_id: string;
  group_id: string;
  group_name: string;
  title: string | null;
  starts_at: string;
  venue_name: string | null;
  venue_address: string | null;
  min_players: number;
  max_players: number;
  price_cents: number;
  currency: string;
  status: GameStatus;
  spots_taken: number;
  has_joined: boolean;
  sport: SportType;
};

/** A `preview_players` entry from `get_group_upcoming_games()` — see 005_group_detail.sql. */
export type GamePreviewPlayer = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
};

/** Raw row shape returned by the `get_group_detail()` RPC — see 005_group_detail.sql. */
export type GroupDetailRow = {
  group_id: string;
  name: string;
  sport: SportType;
  description: string | null;
  cover_image_url: string | null;
  default_venue_name: string | null;
  default_venue_address: string | null;
  default_weekday: number | null;
  default_time: string | null;
  lock_hours: LockHours;
  role: GroupMemberRole;
  member_count: number;
  payout_user_id: string;
  payouts_ready: boolean;
};

/** Raw row shape returned by the `get_group_upcoming_games()` RPC — see 005_group_detail.sql. */
export type GroupGameRow = UpcomingGameRow & {
  preview_players: GamePreviewPlayer[];
};

/** Raw row shape returned by `get_group_members()` — see 022_security_hardening.sql. */
export type GroupMemberRow = {
  id: string;
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  global_mmr: number;
  role: GroupMemberRole;
  joined_at: string;
};

/**
 * Raw row shape for the Create Game group dropdown's direct `group_members`
 * select (embeds `groups` via the `group_id` FK, filtered to
 * `role = 'admin'`) — see mobile/src/features/games/api.ts.
 */
export type CreatableGroupRow = {
  role: GroupMemberRole;
  group: {
    id: string;
    name: string;
    default_venue_name: string | null;
    default_venue_address: string | null;
    default_weekday: number | null;
    /** Postgres `time` column, serialised as `"HH:MM:SS"` over PostgREST. */
    default_time: string | null;
    lock_hours: 24 | 48 | 72;
  } | null;
};

export type PushPlatform = 'ios' | 'android' | 'web';

export type PushToken = {
  id: string;
  user_id: string;
  token: string;
  platform: PushPlatform;
  created_at: string;
  updated_at: string;
};

/** Raw row shape returned by the `get_game_detail()` RPC — see 006_create_game_push.sql / 009_game_duration_score.sql. */
export type GameDetailRow = {
  game_id: string;
  group_id: string;
  group_name: string;
  title: string | null;
  starts_at: string;
  venue_name: string | null;
  venue_address: string | null;
  min_players: number;
  max_players: number;
  price_cents: number;
  currency: string;
  notes: string | null;
  status: GameStatus;
  allow_waitlist: boolean;
  allow_cash: boolean;
  cancel_if_min_not_met_hours: number;
  duration_minutes: number;
  home_color: string;
  away_color: string;
  score_home: number | null;
  score_away: number | null;
  score_notes: string | null;
  created_by: string | null;
  organizer_name: string | null;
  scored_at: string | null;
  motm_user_id: string | null;
  motm_name: string | null;
  motm_closed_at: string | null;
  my_motm_vote_user_id: string | null;
  teams_picked_at: string | null;
  spots_taken: number;
  spots_paid: number;
  waitlist_count: number;
  has_joined: boolean;
  is_waitlisted: boolean;
  is_admin: boolean;
  my_payment_status: PaymentStatus | null;
  my_pending_expires_at: string | null;
  fee_cents: number;
  total_cents: number;
  payouts_ready: boolean;
};

export type GroupPayoutsRow = {
  payout_user_id: string;
  treasurer_name: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  transfers_enabled: boolean;
  is_self: boolean;
  is_admin: boolean;
};

export type MotmBallotRow = {
  game_id: string;
  title: string | null;
  group_name: string;
  scored_at: string | null;
  closes_at: string | null;
  is_open: boolean;
  my_vote_user_id: string | null;
  motm_user_id: string | null;
  motm_name: string | null;
  vote_total: number | null;
  candidate_user_id: string | null;
  candidate_name: string | null;
  candidate_avatar_url: string | null;
  candidate_mmr: number | null;
  candidate_vote_count: number | null;
};

export type GroupPendingInviteRow = {
  invite_id: string;
  invited_user_id: string | null;
  full_name: string | null;
  avatar_url: string | null;
  awaiting_signup: boolean;
  created_at: string;
};

export type GroupHistoryRow = {
  game_id: string;
  title: string | null;
  starts_at: string;
  home_color: string;
  away_color: string;
  score_home: number | null;
  score_away: number | null;
  played_count: number;
};

export type ProfileStatsRow = {
  games_played: number;
  motm_count: number;
  global_mmr: number;
  win_rate: number | null;
};

export type SportBreakdownRow = {
  sport: SportType;
  games_played: number;
};

export type RecentGameRow = {
  game_id: string;
  starts_at: string;
  sport: SportType;
  home_color: string;
  away_color: string;
  score_home: number | null;
  score_away: number | null;
  team: 'home' | 'away' | null;
};

/** Raw row shape returned by `get_game_lobby_players()` — see 022_security_hardening.sql. */
export type GamePlayerRow = {
  id: string;
  user_id: string | null;
  payment_status: PaymentStatus;
  is_waitlisted: boolean;
  joined_at: string;
  team: 'home' | 'away' | null;
  full_name: string | null;
  avatar_url: string | null;
  global_mmr: number | null;
};

export type MmrEventRow = {
  user_id: string;
  delta: number;
};
