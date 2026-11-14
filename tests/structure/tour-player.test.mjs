import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../../site/assets/tour.js', import.meta.url), 'utf8');

function setup(readyState) {
  const english = { kind: 'captions', mode: 'disabled' };
  const korean = { kind: 'captions', mode: 'showing' };
  const embedded = { kind: 'subtitles', mode: 'showing' };
  const player = Object.assign(new EventTarget(), {
    readyState, duration: 100, currentTime: 0, textTracks: [english, korean, embedded],
    querySelector: () => ({ track: english }),
    play: () => Promise.resolve(), load() {}, scrollIntoView() {},
  });
  runInNewContext(source, { document: { getElementById: () => player, querySelectorAll: () => [] } });
  return { player, english, korean, embedded };
}

test('already-loaded metadata selects exactly the external English caption track', () => {
  const { english, korean, embedded } = setup(1);
  assert.equal(english.mode, 'showing');
  assert.equal(korean.mode, 'disabled');
  assert.equal(embedded.mode, 'disabled');
});

test('late metadata initializes captions once and later user choices are retained', () => {
  const { player, english, korean, embedded } = setup(0);
  assert.equal(korean.mode, 'showing');
  player.readyState = 1;
  player.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(english.mode, 'showing');
  assert.equal(korean.mode, 'disabled');
  assert.equal(embedded.mode, 'disabled');
  english.mode = 'disabled';
  korean.mode = 'showing';
  player.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(english.mode, 'disabled');
  assert.equal(korean.mode, 'showing');
});
