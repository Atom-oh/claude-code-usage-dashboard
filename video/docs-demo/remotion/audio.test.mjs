import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {musicVolume, SPEECH_OFFSET_FRAMES, SCENE_FRAMES} from './mix.mjs';
const narration = JSON.parse(readFileSync(new URL('./narration.json', import.meta.url)));
const audio = JSON.parse(readFileSync(new URL('./audio.json', import.meta.url)));

test('every complete narration clip fits its scene without truncating speech', () => {
  assert.equal(audio.clips.length, narration.scenes.length);
  audio.clips.forEach((clip, i) => {
    assert.equal(clip.id, narration.scenes[i].id);
    assert.equal(narration.scenes[i].start_frame, i * SCENE_FRAMES);
    assert.ok(clip.duration_seconds > 0);
    assert.ok(clip.duration_seconds <= 7.65, 'leave the generator’s 0.1-second tail before the scene cut');
    assert.ok(clip.duration_seconds * narration.fps < SCENE_FRAMES - SPEECH_OFFSET_FRAMES);
  });
});

test('the music fades and ducks beneath narration at all six scene boundaries', () => {
  const durations = audio.clips.map((clip) => clip.duration_seconds);
  assert.equal(musicVolume(0, durations), 0);
  assert.equal(musicVolume(1151, durations), 0);
  for (let i = 0; i < durations.length; i++) {
    assert.ok(musicVolume(i * SCENE_FRAMES + 24, durations) <= 0.20);
  }
  for (let frame = 0; frame < 1152; frame++) {
    const volume = musicVolume(frame, durations);
    assert.ok(volume >= 0 && volume <= 0.32);
  }
});

test('English captions match the spoken explanation and measured clip timing', () => {
  const vtt = readFileSync(new URL('../../../site/assets/video/dashboard-demo-en-20261110.vtt', import.meta.url), 'utf8');
  const cues = vtt.trim().split(/\n\n/).slice(1);
  assert.equal(cues.length, narration.scenes.length);
  const seconds = (value) => {
    const [minutes, seconds] = value.split(':').map(Number);
    return minutes * 60 + seconds;
  };
  cues.forEach((cue, i) => {
    const [timing, ...lines] = cue.split('\n');
    const [start, end] = timing.split(' --> ').map(seconds);
    assert.equal(lines.join(' '), narration.scenes[i].text);
    assert.equal(start, (narration.scenes[i].start_frame + SPEECH_OFFSET_FRAMES) / 24);
    assert.ok(Math.abs(end - start - audio.clips[i].duration_seconds) < 0.002);
  });
});
