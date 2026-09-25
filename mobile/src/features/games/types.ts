import type { GameStatus, PaymentStatus } from '../../types/database';

export type CreatableGroupModel = {
  id: string;
  name: string;
  defaultVenueName: string | null;
  defaultVenueAddress: string | null;
  /** 0 (Sunday) – 6 (Saturday), the group's recurring game day — see `groups.default_weekday`. */
  defaultWeekday: number | null;
  defaultHour: number | null;
  defaultMinute: number | null;
  lockHours: 24 | 48 | 72;
};

export type GameDetailModel = {
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
  notes: string | null;
  status: GameStatus;
  allowWaitlist: boolean;
  allowCash: boolean;
  cancelIfMinNotMetHours: number;
  durationMinutes: number;
  homeColor: string;
  awayColor: string;
  scoreHome: number | null;
  scoreAway: number | null;
  scoreNotes: string | null;
  createdBy: string | null;
  organizerName: string | null;
  scoredAt: string | null;
  motmUserId: string | null;
  motmName: string | null;
  motmClosedAt: string | null;
  myMotmVoteUserId: string | null;
  teamsPickedAt: string | null;
  spotsTaken: number;
  spotsPaid: number;
  waitlistCount: number;
  hasJoined: boolean;
  isWaitlisted: boolean;
  isAdmin: boolean;
  myPaymentStatus: PaymentStatus | null;
  myPendingExpiresAt: string | null;
  feeCents: number;
  totalCents: number;
  payoutsReady: boolean;
};

export type MotmCandidateModel = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  mmr: number;
  /** Present only after MOTM close. Null while voting is open. */
  voteCount: number | null;
};

export type MotmBallotModel = {
  gameId: string;
  title: string | null;
  groupName: string;
  scoredAt: string | null;
  closesAt: string | null;
  isOpen: boolean;
  myVoteUserId: string | null;
  motmUserId: string | null;
  motmName: string | null;
  /** Present only after MOTM close. Null while voting is open. */
  voteTotal: number | null;
  candidates: MotmCandidateModel[];
};

export type GamePlayerModel = {
  id: string;
  userId: string | null;
  name: string;
  avatarUrl: string | null;
  mmr: number;
  /** Net MMR change for this game after MOTM close. Null while voting is still open. */
  mmrDelta: number | null;
  paymentStatus: PaymentStatus;
  isWaitlisted: boolean;
  joinedAt: string;
  team: 'home' | 'away' | null;
};
