import type { Ionicons } from '@expo/vector-icons';

import type { SportType } from '../../types/database';

/**
 * Ionicons doesn't have a glyph for every sport in `sport_type` (no
 * rugby/netball/hockey ball icon exists) — those fall back to a generic
 * "shield" icon rather than an inaccurate substitute. See PLAN_PHASE2.md
 * "Figma deviations" for why Ionicons is used instead of Figma's exported
 * sport icon assets.
 */
const SPORT_ICON: Record<SportType, keyof typeof Ionicons.glyphMap> = {
  football: 'football-outline',
  basketball: 'basketball-outline',
  padel: 'tennisball-outline',
  cricket: 'baseball-outline',
  netball: 'basketball-outline',
  rugby: 'shield-outline',
  hockey: 'shield-outline',
  other: 'shield-outline',
};

export function sportIcon(sport: SportType): keyof typeof Ionicons.glyphMap {
  return SPORT_ICON[sport] ?? 'shield-outline';
}
