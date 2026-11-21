export type GameIcsInput = {
  id: string;
  title: string;
  startsAt: string;
  durationMinutes: number;
  venueName: string | null;
  venueAddress: string | null;
  /** Stamp time. Defaults to now. Tests pass a fixed instant. */
  now?: Date;
};

/** Safe cache filename. The id is a game uuid, not a person's data. */
export function gameIcsFilename(gameId: string): string {
  const safe = gameId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 36);
  return `subup-${safe || 'game'}.ics`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC timestamp in the basic ICS form `YYYYMMDDTHHMMSSZ`. */
export function formatIcsUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** RFC 5545 TEXT escaping. */
export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

/** Fold at 75 octets. Our lines are ASCII after escaping, so characters match octets. */
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  let folded = line.slice(0, 75);
  let index = 75;
  while (index < line.length) {
    folded += `\r\n ${line.slice(index, index + 74)}`;
    index += 74;
  }
  return folded;
}

function locationLine(venueName: string | null, venueAddress: string | null): string {
  return [venueName?.trim(), venueAddress?.trim()].filter((part): part is string => !!part).join(', ');
}

/**
 * A single-event calendar file for one game. No player names or other personal data —
 * the user adds it themselves from the share sheet. No calendar permission is used.
 */
export function buildGameIcs(input: GameIcsInput): string {
  const start = new Date(input.startsAt);
  const durationMs = Math.max(0, input.durationMinutes) * 60_000;
  const end = new Date(start.getTime() + durationMs);
  const now = input.now ?? new Date();
  const summary = input.title.trim() || 'SubUp game';
  const location = locationLine(input.venueName, input.venueAddress);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SubUp//Game//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(input.id)}@subupapp.co.uk`,
    `DTSTAMP:${formatIcsUtc(now)}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}
