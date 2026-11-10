export const SPEECH_OFFSET_FRAMES = 6;
export const SCENE_FRAMES = 192;

// Voice is normalized to -18 LUFS. The quiet bed dips further while speech plays.
export function musicVolume(frame, speechDurations, fps = 24) {
  const fade = Math.max(0, Math.min(1, frame / fps, (1151 - frame) / (fps * 2)));
  let gain = 0.32;
  for (let i = 0; i < speechDurations.length; i++) {
    const start = i * SCENE_FRAMES + SPEECH_OFFSET_FRAMES;
    const end = start + speechDurations[i] * fps;
    const ramp = Math.min(1, Math.max(0, (frame - start + 6) / 6),
      Math.max(0, (end + 6 - frame) / 6));
    gain = Math.min(gain, 0.32 - 0.12 * ramp);
  }
  return gain * fade;
}
