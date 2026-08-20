/**
 * PitchIn design tokens.
 *
 * Source of truth for colours/radii/spacing used across the app. Mirrored
 * into `tailwind.config.js` so NativeWind utility classes (e.g. `bg-primary`)
 * stay in sync with these values — update both together.
 *
 * Base four colours are locked by the product spec. `muted`, `border` and
 * `background` are additions needed to match the Figma reference screens
 * (subtitles, input borders, divider lines) — see PLAN.md "Theme tokens".
 */
export const colors = {
  primary: '#0B6E4F',
  accent: '#B8F236',
  ink: '#121212',
  muted: '#60736C',
  border: '#F3F4F6',
  background: '#F4F6F5',
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
