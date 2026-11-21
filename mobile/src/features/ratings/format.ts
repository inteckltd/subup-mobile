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

/** "Based on 2 games" — how many results the group rating is drawn from. */
export function reliabilityLabel(ratedGames: number): string {
  const count = Math.max(0, ratedGames);
  return `Based on ${count} ${count === 1 ? 'game' : 'games'}`;
}

/** "Rating 1,040 · Based on 18 games" — always a group rating. */
export function formatGroupRating(mmr: number, ratedGames: number): string {
  return `Rating ${mmr.toLocaleString('en-GB')} · ${reliabilityLabel(ratedGames)}`;
}
