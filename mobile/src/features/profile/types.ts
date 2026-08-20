import type { SportType } from '../../types/database';

export type ProfileStatsModel = {
  gamesPlayed: number;
  motmCount: number;
  globalMmr: number;
  winRate: number | null;
};

export type SportBreakdownModel = {
  sport: SportType;
  gamesPlayed: number;
};

export type FormResult = 'W' | 'D' | 'L';

export type RecentGameModel = {
  id: string;
  startsAt: string;
  sport: SportType;
  homeColor: string;
  awayColor: string;
  scoreHome: number | null;
  scoreAway: number | null;
  team: 'home' | 'away';
  result: FormResult;
};
