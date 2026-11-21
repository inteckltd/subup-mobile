import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { oneWeekLater, repeatGameFormValues } from './repeatGame';

describe('oneWeekLater', () => {
  it('keeps the local kickoff and moves the calendar day forward by 7', () => {
    const start = new Date(2026, 10, 21, 19, 30, 0, 0);
    const next = oneWeekLater(start);
    assert.equal(next.getFullYear(), 2026);
    assert.equal(next.getMonth(), 10);
    assert.equal(next.getDate(), 28);
    assert.equal(next.getHours(), 19);
    assert.equal(next.getMinutes(), 30);
  });

  it('rolls into the next month', () => {
    const start = new Date(2026, 0, 28, 19, 30, 0, 0);
    const next = oneWeekLater(start);
    assert.equal(next.getMonth(), 1);
    assert.equal(next.getDate(), 4);
    assert.equal(next.getHours(), 19);
    assert.equal(next.getMinutes(), 30);
  });

  it('keeps 7:30pm local across the spring clock change', () => {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London');
    const before = new Date(2026, 2, 22, 19, 30, 0, 0);
    const after = oneWeekLater(before);
    assert.equal(after.getDate(), 29);
    assert.equal(after.getHours(), 19);
    assert.equal(after.getMinutes(), 30);
    const plus168h = new Date(before.getTime() + 7 * 24 * 60 * 60 * 1000);
    assert.equal(plus168h.getHours(), 20);
    assert.notEqual(after.getTime(), plus168h.getTime());
  });
});

describe('repeatGameFormValues', () => {
  it('copies venue, cost, duration, and a kickoff one week later', () => {
    const values = repeatGameFormValues({
      groupId: 'group-1',
      title: 'Sunday kickabout',
      startsAt: new Date(2026, 10, 21, 19, 30, 0, 0).toISOString(),
      venueName: 'Powerleague',
      venueAddress: 'Pitch 2',
      minPlayers: 10,
      maxPlayers: 14,
      priceCents: 650,
      durationMinutes: 90,
      homeColor: 'green',
      awayColor: 'yellow',
      allowWaitlist: false,
    });

    assert.equal(values.groupId, 'group-1');
    assert.equal(values.title, 'Sunday kickabout');
    assert.equal(values.venueName, 'Powerleague');
    assert.equal(values.venueAddress, 'Pitch 2');
    assert.equal(values.pricePounds, 6.5);
    assert.equal(values.durationMinutes, 90);
    assert.equal(values.minPlayers, 10);
    assert.equal(values.maxPlayers, 14);
    assert.equal(values.homeColor, 'green');
    assert.equal(values.awayColor, 'yellow');
    assert.equal(values.allowWaitlist, false);
    assert.equal(values.allowCash, false);
    assert.equal(values.date.getDate(), 28);
    assert.equal(values.date.getHours(), 19);
    assert.equal(values.date.getMinutes(), 30);
    assert.equal(values.time.getTime(), values.date.getTime());
  });
});
