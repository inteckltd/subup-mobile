/**
 * SubUp design tokens.
 *
 * Source of truth for colours/radii/spacing used across the app. Mirrored
 * into `tailwind.config.js` so NativeWind utility classes (e.g. `bg-primary`)
 * stay in sync with these values — update both together.
 *
 * Base four colours are locked by the product spec. `muted`, `border` and
 * `white` are supporting tokens for subtitles, dividers, and cards.
 */
export const colors = {
  primary: '#032488',
  accent: '#05deed',
  ink: '#010101',
  muted: '#5C6B8A',
  border: '#F3F4F6',
  background: '#FEFEFD',
  white: '#FFFFFF',
  danger: '#DC2626',
  /** Warm metallic gold — used sparingly for gamification highlights (e.g. the MMR chip). */
  gold: '#F2C14E',
} as const;

export const radii = {
  control: 16,
  card: 40,
  pill: 12,
} as const;

export const spacing = {
  screenPadding: 24,
} as const;

export type ColorToken = keyof typeof colors;
