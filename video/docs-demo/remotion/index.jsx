import React from 'react';
import {AbsoluteFill, Audio, Composition, OffthreadVideo, Sequence,
  registerRoot, staticFile} from 'remotion';
import narration from './narration.json';
import audio from './audio.json';
import {musicVolume, SPEECH_OFFSET_FRAMES, SCENE_FRAMES} from './mix.mjs';

const NarratedDocsDemo = () => (
  <AbsoluteFill style={{backgroundColor: '#071525'}}>
    <OffthreadVideo src={staticFile('visual-base.mp4')} muted
      style={{width: '100%', height: '100%'}} />
    <Audio src={staticFile('background.wav')}
      volume={(frame) => musicVolume(frame, audio.clips.map((clip) => clip.duration_seconds))}
    />
    {narration.scenes.map((scene) => (
      <Sequence key={scene.id} from={scene.start_frame + SPEECH_OFFSET_FRAMES}
        durationInFrames={SCENE_FRAMES - SPEECH_OFFSET_FRAMES} layout="none">
        <Audio src={staticFile(`${scene.id}.mp3`)} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

registerRoot(() => (
  <Composition id="NarratedDocsDemo" component={NarratedDocsDemo}
    width={1920} height={1080} fps={narration.fps}
    durationInFrames={narration.duration_frames} />
));
