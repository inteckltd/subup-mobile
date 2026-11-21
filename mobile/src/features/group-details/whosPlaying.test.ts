import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWhosPlayingMessage, shareDisplayName } from './whosPlaying';

describe('shareDisplayName', () => {
  it('keeps a normal name and strips phones and emails', () => {
    assert.equal(shareDisplayName('Alex Smith'), 'Alex Smith');
    assert.equal(shareDisplayName('Sam 07700 900123'), 'Sam');
    assert.equal(shareDisplayName('07700900123'), 'Player');
    assert.equal(shareDisplayName('Dave dave@example.com'), 'Dave');
  });
});

describe('buildWhosPlayingMessage', () => {
  it('lists confirmed names, spots, and the invite link', () => {
    const message = buildWhosPlayingMessage({
      title: 'Sunday kickabout',
      when: 'Friday, 28 Nov • 7:30pm',
      venueName: 'Powerleague',
      venueAddress: 'Pitch 2',
      confirmedNames: ['Alex Smith', 'Sam 07700 900123'],
      spotsLeft: 6,
      joinUrl: 'https://www.subupapp.co.uk/join/abc',
    });

    assert.match(message, /Who's playing — Sunday kickabout/);
    assert.match(message, /Friday, 28 Nov • 7:30pm/);
    assert.match(message, /Powerleague/);
    assert.match(message, /Pitch 2/);
    assert.match(message, /1\. Alex Smith/);
    assert.match(message, /2\. Sam/);
    assert.match(message, /6 spots left/);
    assert.match(message, /Join the group: https:\/\/www\.subupapp\.co\.uk\/join\/abc/);
    assert.equal(message.includes('07700'), false);
    assert.equal(message.includes('@'), false);
  });

  it('omits the invite link when there is not one', () => {
    const message = buildWhosPlayingMessage({
      title: 'Sunday kickabout',
      when: 'Friday, 28 Nov • 7:30pm',
      venueName: null,
      venueAddress: null,
      confirmedNames: [],
      spotsLeft: 1,
    });
    assert.match(message, /No one yet/);
    assert.match(message, /1 spot left/);
    assert.equal(message.includes('Join the group'), false);
  });

  it('does not pretend the pitch is empty when the list failed to load', () => {
    const message = buildWhosPlayingMessage({
      title: 'Sunday kickabout',
      when: 'Friday, 28 Nov • 7:30pm',
      venueName: null,
      venueAddress: null,
      confirmedNames: [],
      spotsLeft: 0,
      playersUnavailable: true,
    });
    assert.match(message, /Couldn't load the player list/);
    assert.equal(message.includes('No one yet'), false);
    assert.match(message, /No spots left/);
  });
});
