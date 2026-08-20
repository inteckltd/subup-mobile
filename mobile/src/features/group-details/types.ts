import type { GameStatus, GroupMemberRole, LockHours, SportType } from '../../types/database';

export type GroupDetailModel = {
  id: string;
  name: string;
  sport: SportType;
  description: string | null;
  coverImageUrl: string | null;
  venueName: string | null;
  venueAddress: string | null;
  defaultWeekday: number | null;
  defaultTime: string | null;
  lockHours: LockHours;
  role: GroupMemberRole;
  memberCount: number;
};

export type GroupMemberModel = {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  mmr: number;
  role: GroupMemberRole;
  joinedAt: string;
};

export type GroupPendingInviteModel = {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
};

export type GroupHistoryModel = {
  id: string;
  title: string | null;
  startsAt: string;
  homeColor: string;
  awayColor: string;
  scoreHome: number | null;
  scoreAway: number | null;
  playedCount: number;
};

export type GamePreviewPlayerModel = {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
};

export type GroupGameModel = {
  id: string;
  groupId: string;
  title: string | null;
  startsAt: string;
  venueName: string | null;
  venueAddress: string | null;
  minPlayers: number;
  maxPlayers: number;
  priceCents: number;
  currency: string;
  status: GameStatus;
  spotsTaken: number;
  spotsLeft: number;
  hasJoined: boolean;
  sport: SportType;
  previewPlayers: GamePreviewPlayerModel[];
};
