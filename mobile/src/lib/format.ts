/**
 * UK-locale date/time and price formatting for Home's game cards.
 * All date/time formatting is pinned to the `Europe/London` timezone
 * regardless of device locale/timezone, since SubUp is a UK product.
 */

const LONDON_TZ = 'Europe/London';

function londonDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function daysBetween(a: Date, b: Date): number {
  const aParts = londonDateParts(a);
  const bParts = londonDateParts(b);
  const aUtc = Date.UTC(aParts.year, aParts.month - 1, aParts.day);
  const bUtc = Date.UTC(bParts.year, bParts.month - 1, bParts.day);
  return Math.round((bUtc - aUtc) / 86_400_000);
}

/**
 * "Tonight" / "Today" / "Tomorrow" / short weekday ("Sat") for a game's
 * `starts_at`, relative to `now` (defaults to the current time).
 */
export function formatGameDayLabel(startsAt: string, now: Date = new Date()): string {
  const date = new Date(startsAt);
  const diffDays = daysBetween(now, date);

  if (diffDays === 0) {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, hour: 'numeric', hourCycle: 'h23' }).format(date)
    );
    return hour >= 17 ? 'Tonight' : 'Today';
  }
  if (diffDays === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, weekday: 'short' }).format(date);
}

/** "7:30pm" — UK 12-hour clock, lowercase am/pm, no space. */
export function formatUkTime(startsAt: string): string {
  const date = new Date(startsAt);
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).format(date);
  return formatted.replace(/\s?([AaPp][Mm])$/, (_, meridiem) => meridiem.toLowerCase());
}

/** "Sat 21 Feb" style full date, used for group/game stub screens & a11y labels. */
export function formatUkDate(startsAt: string): string {
  const date = new Date(startsAt);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/** "FRIDAY, OCT 24" — full uppercase weekday + short month/day, used by the Group Details full-width game card. */
export function formatFullDateLabel(startsAt: string): string {
  const date = new Date(startsAt);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, weekday: 'long' }).format(date);
  const monthDay = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, month: 'short', day: 'numeric' }).format(date);
  return `${weekday}, ${monthDay}`.toUpperCase();
}

/**
 * Whether a joined player is currently locked out of leaving a game — true
 * within `lockHours` (default 24, matching `games.cancel_if_min_not_met_hours`)
 * of `starts_at`. Encapsulated here (rather than inline in a component) so
 * the `Date.now()` call happens inside a plain utility function, not a
 * component's render body — see GroupGameCard.tsx.
 */
export function hoursUntilStart(startsAt: string, now: Date = new Date()): number {
  return (new Date(startsAt).getTime() - now.getTime()) / (1000 * 60 * 60);
}

/**
 * True once fewer than `lockHours` remain before kickoff. `lockHours <= 0`
 * (legacy "rule off") is never inside the window.
 */
export function isInsideLockWindow(startsAt: string, lockHours: number, now: Date = new Date()): boolean {
  if (lockHours <= 0) return false;
  return hoursUntilStart(startsAt, now) < lockHours;
}

export function isGameLeaveLocked(startsAt: string, hasJoined: boolean, lockHours = 24): boolean {
  if (!hasJoined) return false;
  return isInsideLockWindow(startsAt, lockHours);
}

/** "Friday, 24 Oct • 7:30pm" — lobby header date line. */
export function formatLobbyDateTime(startsAt: string): string {
  const date = new Date(startsAt);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(date);
  return `${day} • ${formatUkTime(startsAt)}`;
}

/** Instant when the leave-lock / below-min deadline fires (`starts_at - N hours`). */
export function lockDeadlineAt(startsAt: string, lockHours: number): Date {
  return new Date(new Date(startsAt).getTime() - lockHours * 60 * 60 * 1000);
}

/** "7:30pm on Fri 21 Feb" — used in the below-min warning copy. */
export function formatLockDeadline(startsAt: string, lockHours: number): string {
  const iso = lockDeadlineAt(startsAt, lockHours).toISOString();
  return `${formatUkTime(iso)} on ${formatUkDate(iso)}`;
}

/** Live countdown: "1d 23h 47m", "04h 22m 15s", or "22m 15s". */
export function formatCountdown(startsAt: string, now: Date = new Date()): string {
  const totalSeconds = Math.max(0, Math.floor((new Date(startsAt).getTime() - now.getTime()) / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  if (hours > 0) return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${pad(minutes)}m ${pad(seconds)}s`;
}

/** London-local date key (`YYYY-MM-DD`) for grouping upcoming games. */
export function londonDateKey(startsAt: string): string {
  const { year, month, day } = londonDateParts(new Date(startsAt));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** price_cents -> "£5", "£4.50", or "Free" for 0. GBP only (spec default currency). */
export function formatGbp(priceCents: number): string {
  if (!priceCents || priceCents <= 0) return 'Free';
  const pounds = priceCents / 100;
  const hasPence = priceCents % 100 !== 0;
  return `£${hasPence ? pounds.toFixed(2) : pounds.toFixed(0)}`;
}

/** minutes -> "30 min" / "1 hr" / "1.5 hr" — same rounding as `DURATION_OPTIONS` labels in features/games/schemas.ts. */
export function formatDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} hr`;
}

/** A game's `starts_at` + `duration_minutes` as an ISO instant — the "game has finished" cutoff used by both the score-reminder sweep and `submit_game_score`. */
export function gameEndsAt(startsAt: string, durationMinutes: number): Date {
  return new Date(new Date(startsAt).getTime() + durationMinutes * 60_000);
}

/** Whether a game's end time (`starts_at + duration_minutes`) has already passed, relative to `now` (defaults to the current time). */
export function hasGameEnded(startsAt: string, durationMinutes: number, now: Date = new Date()): boolean {
  return gameEndsAt(startsAt, durationMinutes).getTime() <= now.getTime();
}
