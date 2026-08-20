import { z } from 'zod';

import type { LockHours, SportType } from '../../types/database';

/**
 * Displayed Monday-first (UK convention), but `value` follows the
 * Postgres/JS `0 = Sunday` convention used by `groups.default_weekday`'s
 * check constraint (`003_domain.sql`) — decouples display order from the
 * stored value.
 */
export const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
] as const;

export const LOCK_HOURS_OPTIONS: { value: LockHours; label: string }[] = [
  { value: 24, label: '24h' },
  { value: 48, label: '48h' },
  { value: 72, label: '72h' },
];

export const SPORT_OPTIONS: { value: SportType; label: string }[] = [
  { value: 'football', label: 'Football' },
  { value: 'rugby', label: 'Rugby' },
  { value: 'padel', label: 'Padel' },
  { value: 'basketball', label: 'Basketball' },
  { value: 'netball', label: 'Netball' },
  { value: 'cricket', label: 'Cricket' },
  { value: 'hockey', label: 'Hockey' },
  { value: 'other', label: 'Other' },
];

export const createGroupSchema = z.object({
  name: z.string().trim().min(2, 'Enter a group name'),
  description: z.string().trim().max(500, 'Keep it under 500 characters').optional(),
  coverImageUri: z.string().optional(),
  sport: z.enum(['football', 'rugby', 'padel', 'basketball', 'netball', 'cricket', 'hockey', 'other']),
  lockHours: z.union([z.literal(24), z.literal(48), z.literal(72)]),
  venueName: z.string().trim().min(1, 'Enter a venue name'),
  venueAddress: z.string().trim().min(1, 'Enter a venue address'),
  weekday: z.number().min(0).max(6),
  hour: z.number().min(0).max(23),
  minute: z.number().min(0).max(59),
});

export type CreateGroupFormValues = z.infer<typeof createGroupSchema>;

/**
 * Defaults mirror PLAN_PHASE2.md's own seed data ("Friday Night Ballers",
 * kicking off 7:30pm) — a sensible, familiar starting point rather than
 * midnight/Sunday.
 */
export const createGroupDefaultValues: CreateGroupFormValues = {
  name: '',
  description: '',
  coverImageUri: undefined,
  sport: 'football',
  lockHours: 24,
  venueName: '',
  venueAddress: '',
  weekday: 5,
  hour: 19,
  minute: 30,
};
