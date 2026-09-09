import { z } from 'zod';

/** Preset duration options offered on Create Game — minutes + display label. */
export const DURATION_OPTIONS = [
  { minutes: 30, label: '30 min' },
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 90, label: '1.5 hr' },
  { minutes: 120, label: '2 hr' },
  { minutes: 150, label: '2.5 hr' },
  { minutes: 180, label: '3 hr' },
] as const;

export type DurationMinutes = (typeof DURATION_OPTIONS)[number]['minutes'];

/**
 * Fixed bib/kit colour palette for the home/away team colour picker — must
 * stay in sync with the `games_home_color_allowed`/`games_away_color_allowed`
 * CHECK constraints in supabase/migrations/009_game_duration_score.sql.
 */
export const TEAM_COLORS = [
  { id: 'red', label: 'Red', hex: '#EF4444' },
  { id: 'blue', label: 'Blue', hex: '#3B82F6' },
  { id: 'green', label: 'Green', hex: '#10B981' },
  { id: 'yellow', label: 'Yellow', hex: '#F59E0B' },
  { id: 'orange', label: 'Orange', hex: '#F97316' },
  { id: 'purple', label: 'Purple', hex: '#8B5CF6' },
  { id: 'black', label: 'Black', hex: '#111827' },
  { id: 'white', label: 'White', hex: '#F9FAFB' },
] as const;

export type TeamColorId = (typeof TEAM_COLORS)[number]['id'];

const teamColorIds = TEAM_COLORS.map((color) => color.id) as [TeamColorId, ...TeamColorId[]];

/** Looks up a `TEAM_COLORS` entry by id, falling back to red if somehow unset/unknown (defensive only — DB constraints already guarantee a valid value). */
export function teamColorById(id: string) {
  return TEAM_COLORS.find((color) => color.id === id) ?? TEAM_COLORS[0];
}

/**
 * `date`/`time` are kept as separate JS `Date`s (matching the two separate
 * Figma fields) and combined into a single UTC `starts_at` timestamp at
 * submit time — see `combineDateAndTime` below. Both default to sensible
 * near-future values so the form is valid (not blank/invalid) the moment it
 * opens, same spirit as Create Group's `createGroupDefaultValues`.
 */
export const createGameSchema = z
  .object({
    groupId: z.string().min(1, 'Select a group'),
    title: z.string().trim().max(80, 'Keep the game name under 80 characters').optional(),
    date: z.date(),
    time: z.date(),
    venueName: z.string().trim().min(1, 'Enter a venue name'),
    venueAddress: z.string().trim().optional(),
    minPlayers: z.number().int().min(1, 'Min players must be at least 1'),
    maxPlayers: z.number().int().min(1, 'Max players must be at least 1'),
    pricePounds: z
      .number()
      .min(0, 'Price cannot be negative')
      .max(1000, 'Keep the price under £1,000'),
    durationMinutes: z.number().int().min(1, 'Select a duration'),
    homeColor: z.enum(teamColorIds),
    awayColor: z.enum(teamColorIds),
    allowWaitlist: z.boolean(),
    allowCash: z.boolean(),
  })
  .refine((values) => values.maxPlayers > values.minPlayers, {
    message: 'Max players must be at least 1 more than the minimum players',
    path: ['maxPlayers'],
  })
  .refine((values) => values.homeColor !== values.awayColor, {
    message: 'Home and away colours must be different',
    path: ['awayColor'],
  });

export type CreateGameFormValues = z.infer<typeof createGameSchema>;

/** Next occurrence of `hour:minute` local time, today if it hasn't passed yet, else tomorrow. */
function nextOccurrenceOf(hour: number, minute: number): Date {
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/**
 * Next occurrence of a given weekday + `hour:minute` local time — e.g. a
 * group whose `default_weekday`/`default_time` is "Friday 7:30pm" resolves
 * to this coming Friday at 7:30pm, or *today* at 7:30pm if today already is
 * that weekday and the time hasn't passed yet. `weekday` follows the JS/PG
 * `0 = Sunday` convention (see `groups.default_weekday`, `WEEKDAYS` in
 * `features/groups/schemas.ts`).
 */
export function nextOccurrenceOfWeekdayTime(weekday: number, hour: number, minute: number): Date {
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  let daysUntil = (weekday - next.getDay() + 7) % 7;
  if (daysUntil === 0 && next.getTime() <= Date.now()) {
    daysUntil = 7;
  }
  next.setDate(next.getDate() + daysUntil);
  return next;
}

/**
 * Defaults mirror Create Group's own defaults (7:30pm kickoff) and the
 * Figma reference's Min/Max Players example (10/14) — a sensible starting
 * point, not blank/zeroed fields the admin must fill in from scratch.
 */
export const createGameDefaultValues: CreateGameFormValues = {
  groupId: '',
  title: '',
  date: nextOccurrenceOf(19, 30),
  time: nextOccurrenceOf(19, 30),
  venueName: '',
  venueAddress: '',
  minPlayers: 10,
  maxPlayers: 14,
  pricePounds: 5,
  durationMinutes: 60,
  homeColor: 'red',
  awayColor: 'blue',
  allowWaitlist: true,
  allowCash: false,
};

/** Combines the `date` field's calendar day with the `time` field's clock time into one Date (local time). */
export function combineDateAndTime(date: Date, time: Date): Date {
  const combined = new Date(date);
  combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return combined;
}

/** Pounds (e.g. 5, 5.5, "8.00") -> integer pence for `price_cents`. */
export function poundsToCents(pounds: number): number {
  return Math.round(pounds * 100);
}

export function centsToPounds(cents: number): number {
  return cents / 100;
}

/** Keep at most one decimal point and two pence digits while typing £4.50. */
export function sanitizePriceInput(raw: string): string {
  const cleaned = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  const whole = cleaned.slice(0, dot);
  const fraction = cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  return `${whole}.${fraction}`;
}

export function parsePricePounds(text: string): number {
  if (!text || text === '.') return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Display helper for the price field — whole pounds as "5", pence as "4.50". */
export function formatPriceField(pounds: number): string {
  if (!Number.isFinite(pounds)) return '';
  if (pounds === 0) return '0';
  return Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2);
}

/** Extra Create Game check: kickoff must sit outside the group's leave-lock window. */
export function createGameSchemaForLock(lockHours: number | null | undefined) {
  const hours = lockHours && lockHours > 0 ? lockHours : 0;
  return createGameSchema.superRefine((values, ctx) => {
    if (hours <= 0 || !values.groupId) return;
    const startsAt = combineDateAndTime(values.date, values.time);
    if (startsAt.getTime() < Date.now() + hours * 60 * 60 * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Kickoff must be at least ${hours} hours away`,
        path: ['date'],
      });
    }
  });
}
