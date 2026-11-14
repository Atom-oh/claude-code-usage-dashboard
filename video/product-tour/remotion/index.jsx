import React from 'react';
import {AbsoluteFill, Audio, Composition, Sequence, registerRoot, staticFile} from 'remotion';
import timing from '../timing.json';
import {musicVolume} from './mix.mjs';
const TourAudio = () => <AbsoluteFill style={{backgroundColor: '#0b1524'}}>
  <Audio src={staticFile('background.mp3')} volume={(frame) => musicVolume(frame, timing)} />
  {timing.scenes.map((scene) => <Sequence key={scene.id} from={scene.speech_start_frame}
    durationInFrames={Math.ceil(scene.speech_duration_seconds * timing.fps) + 1} layout="none">
    <Audio src={staticFile(`${scene.id}.mp3`)} />
  </Sequence>)}
</AbsoluteFill>;
registerRoot(() => <Composition id="TourAudio" component={TourAudio} width={1920} height={1080}
  fps={timing.fps} durationInFrames={timing.duration_frames} />);
