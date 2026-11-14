import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {musicVolume} from './remotion/mix.mjs';
const read=(file)=>JSON.parse(readFileSync(new URL(file,import.meta.url)));
const script=read('./script.json'),audio=read('./audio.json'),timing=read('./timing.json'),captions=read('./captions.en.json');

test('every measured speech clip fits completely inside a contiguous scene',()=>{
  assert.equal(timing.script_sha256,createHash('sha256').update(readFileSync(new URL('./script.json',import.meta.url))).digest('hex'));
  assert.deepEqual(script.scenes.map(s=>s.id),timing.scenes.map(s=>s.id));
  assert.equal(audio.clips.length,timing.scenes.length);
  let end=0;
  timing.scenes.forEach((scene,i)=>{
    assert.equal(scene.start_frame,end);assert.equal(scene.id,audio.clips[i].id);
    assert.equal(scene.speech_duration_seconds,audio.clips[i].duration_seconds);
    assert(scene.speech_start_frame>scene.start_frame);
    assert(scene.speech_start_frame+scene.speech_duration_seconds*timing.fps<scene.start_frame+scene.duration_frames-1);
    assert.equal(scene.marks.length,script.scenes[i].segments.length);
    let last=-1;scene.marks.forEach((mark,index)=>{assert.equal(mark.segment,index);assert(mark.time_seconds>last);last=mark.time_seconds;});
    assert(last<scene.speech_duration_seconds);end=scene.start_frame+scene.duration_frames;
  });
  assert.equal(end,timing.duration_frames);
});

test('English captions retain every spoken sentence and generated VTT cue',()=>{
  assert.deepEqual(Object.keys(captions),script.scenes.map(s=>s.id));
  let count=0;
  script.scenes.forEach(scene=>{assert.equal(captions[scene.id].length,scene.segments.length);captions[scene.id].forEach(s=>assert(typeof s==='string'&&s.trim()));count+=scene.segments.length;});
  for(const language of ['en','ko']){
    const text=readFileSync(new URL(`./captions.${language}.vtt`,import.meta.url),'utf8');
    assert(text.startsWith('WEBVTT\n'));assert.equal((text.match(/ --> /g)||[]).length,count);
  }
});

test('music fades at the ends and stays ducked beneath each narration clip',()=>{
  assert.equal(musicVolume(0,timing),0);assert.equal(musicVolume(timing.duration_frames-1,timing),0);
  for(const scene of timing.scenes){assert(musicVolume(scene.speech_start_frame+timing.fps,timing)<=.100001);}
  for(let frame=0;frame<timing.duration_frames;frame+=12){const gain=musicVolume(frame,timing);assert(gain>=0&&gain<=.2);}
});
