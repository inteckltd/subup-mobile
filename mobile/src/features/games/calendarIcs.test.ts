import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGameIcs, gameIcsFilename } from './calendarIcs';

describe('buildGameIcs', () => {
  it('includes the title, start, duration, and location, and no player data', () => {
    const ics = buildGameIcs({
      id: 'game-1',
      title: 'Sunday, kickabout',
      startsAt: '2026-11-21T19:30:00.000Z',
      durationMinutes: 60,
      venueName: 'Powerleague',
      venueAddress: 'Pitch 2; Shoreditch',
      now: new Date('2026-11-01T12:00:00.000Z'),
    });

    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /UID:game-1@subupapp\.co\.uk/);
    assert.match(ics, /DTSTAMP:20261101T120000Z/);
    assert.match(ics, /DTSTART:20261121T193000Z/);
    assert.match(ics, /DTEND:20261121T203000Z/);
    assert.match(ics, /SUMMARY:Sunday\\, kickabout/);
    assert.match(ics, /LOCATION:Powerleague\\, Pitch 2\\; Shoreditch/);
    assert.equal(ics.includes('07700'), false);
    assert.equal(ics.endsWith('\r\n'), true);
  });

  it('folds a long summary', () => {
    const ics = buildGameIcs({
      id: 'game-2',
      title: 'A'.repeat(90),
      startsAt: '2026-11-21T19:30:00.000Z',
      durationMinutes: 30,
      venueName: null,
      venueAddress: null,
      now: new Date('2026-11-01T12:00:00.000Z'),
    });
    const summary = ics.split('\r\n').filter((line) => line.startsWith('SUMMARY') || line.startsWith(' '));
    assert.ok(summary[0].length <= 75);
    assert.ok(summary.some((line) => line.startsWith(' ')));
  });
});

describe('gameIcsFilename', () => {
  it('keeps a uuid and drops anything else', () => {
    assert.equal(gameIcsFilename('ABC-123'), 'subup-abc-123.ics');
    assert.equal(gameIcsFilename('../etc/passwd'), 'subup-etcpasswd.ics');
  });
});
