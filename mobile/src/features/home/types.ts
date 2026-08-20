import type { GameStatus, GroupMemberRole, SportType } from '../../types/database';

export type GroupCardModel = {
  id: string;
  name: string;
  sport: SportType;
  coverImageUrl: string | null;
  role: GroupMemberRole;
  memberCount: number;
};

export type GameCardModel = {
  id: string;
  groupId: string;
  groupName: string;
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
};
