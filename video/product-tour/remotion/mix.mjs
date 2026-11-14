export function musicVolume(frame, timing) {
  const fps = timing.fps;
  const fade = Math.max(0, Math.min(1, frame / (fps * 2), (timing.duration_frames - 1 - frame) / (fps * 3)));
  let gain = 0.20;
  for (const scene of timing.scenes) {
    const start = scene.speech_start_frame;
    const end = start + scene.speech_duration_seconds * fps;
    const ramp = Math.max(0, Math.min(1, (frame - start + 6) / 6, (end + 6 - frame) / 6));
    gain = Math.min(gain, 0.20 - 0.10 * ramp);
  }
  return gain * fade;
}
