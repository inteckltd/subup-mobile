export type WhosPlayingInput = {
  title: string;
  /** Already formatted, e.g. "Friday, 28 Nov • 7:30pm". */
  when: string;
  venueName: string | null;
  venueAddress: string | null;
  /** Confirmed players' display names. Nothing else — no phones, emails, or ids. */
  confirmedNames: string[];
  spotsLeft: number;
  /** Admin share only. Omit when the caller has no join link. */
  joinUrl?: string | null;
  /** True when the lobby request failed. Don't claim the pitch is empty. */
  playersUnavailable?: boolean;
};

/** Drop phones and emails if someone put them in a display name. */
export function shareDisplayName(name: string): string {
  const cleaned = name
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/\+?\d[\d\s()-]{8,}\d/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Player';
}

function spotsLine(spotsLeft: number): string {
  if (spotsLeft <= 0) return 'No spots left';
  if (spotsLeft === 1) return '1 spot left';
  return `${spotsLeft} spots left`;
}

/**
 * Short plain text for WhatsApp and the share sheet.
 * Names only. Never a phone number, email, or other personal field.
 */
export function buildWhosPlayingMessage(input: WhosPlayingInput): string {
  const lines: string[] = [`Who's playing — ${input.title.trim() || 'Game'}`];
  if (input.when.trim()) lines.push(input.when.trim());
  const venue = input.venueName?.trim();
  const address = input.venueAddress?.trim();
  if (venue) lines.push(venue);
  if (address && address !== venue) lines.push(address);

  lines.push('');
  if (input.playersUnavailable) {
    lines.push("Couldn't load the player list. Open the game in SubUp to see who's in.");
  } else {
    const shown = input.confirmedNames.map(shareDisplayName);
    lines.push('Confirmed:');
    if (shown.length === 0) {
      lines.push('No one yet.');
    } else {
      shown.forEach((name, index) => {
        lines.push(`${index + 1}. ${name}`);
      });
    }
  }

  lines.push('');
  lines.push(spotsLine(Math.max(0, Math.floor(input.spotsLeft))));

  const joinUrl = input.joinUrl?.trim();
  if (joinUrl) {
    lines.push('');
    lines.push(`Join the group: ${joinUrl}`);
  }

  return lines.join('\n');
}
