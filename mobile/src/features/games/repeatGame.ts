import { centsToPounds, teamColorById, type CreateGameFormValues } from './schemas';

/**
 * Fields copied onto Create Game. The screen still submits through the
 * existing `create_game` path — this only builds the form values.
 */
export type RepeatGameSource = {
  groupId: string;
  title: string | null;
  startsAt: string;
  venueName: string | null;
  venueAddress: string | null;
  minPlayers: number;
  maxPlayers: number;
  priceCents: number;
  durationMinutes: number;
  homeColor: string;
  awayColor: string;
  allowWaitlist: boolean;
};

/**
 * Same local clock time, 7 calendar days later.
 * `setDate` keeps the wall-clock kickoff across UK BST, unlike adding 168 hours.
 */
export function oneWeekLater(from: Date): Date {
  const next = new Date(from.getTime());
  next.setDate(next.getDate() + 7);
  return next;
}

/** Create Game values for "Same again next week". Cash stays off — create always sends `allow_cash: false`. */
export function repeatGameFormValues(game: RepeatGameSource): CreateGameFormValues {
  const kickoff = oneWeekLater(new Date(game.startsAt));
  return {
    groupId: game.groupId,
    title: game.title ?? '',
    date: kickoff,
    time: kickoff,
    venueName: game.venueName ?? '',
    venueAddress: game.venueAddress ?? '',
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    pricePounds: centsToPounds(game.priceCents),
    durationMinutes: game.durationMinutes,
    homeColor: teamColorById(game.homeColor).id,
    awayColor: teamColorById(game.awayColor).id,
    allowWaitlist: game.allowWaitlist,
    allowCash: false,
  };
}
