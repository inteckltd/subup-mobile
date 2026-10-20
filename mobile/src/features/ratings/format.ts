/** Highest rated-game count that is still Low reliability (0-10 games). */
export const LOW_RELIABILITY_MAX_GAMES = 10;

/** Highest rated-game count that is still Medium reliability (11-18 games). */
export const MEDIUM_RELIABILITY_MAX_GAMES = 18;

export type RatingReliability = 'Low' | 'Medium' | 'High';

/** How much to trust a group rating: it sharpens with every rated game in that group. */
export function ratingReliability(ratedGames: number): RatingReliability {
  if (ratedGames <= LOW_RELIABILITY_MAX_GAMES) return 'Low';
  if (ratedGames <= MEDIUM_RELIABILITY_MAX_GAMES) return 'Medium';
  return 'High';
}

/** "Reliability: Medium" */
export function reliabilityLabel(ratedGames: number): string {
  return `Reliability: ${ratingReliability(ratedGames)}`;
}

/** "1,040 MMR · Reliability: High" — always a group rating. */
export function formatGroupRating(mmr: number, ratedGames: number): string {
  return `${mmr.toLocaleString('en-GB')} MMR · ${reliabilityLabel(ratedGames)}`;
}
