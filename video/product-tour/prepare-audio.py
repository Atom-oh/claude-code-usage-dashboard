#!/usr/bin/env python3
"""Explicit paid Polly generation; cached clips are reused by source hash."""
from array import array
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent
ALIASES = {
    "Claude Code": "클로드 코드", "Codex": "코덱스", "ccdash": "씨씨 대시",
    "Overview": "오버뷰", "Executive": "이그제큐티브", "Trends": "트렌즈",
    "Users": "유저스", "Cost": "코스트", "Productivity": "프로덕티비티",
    "Usage": "유시지", "Reliability": "릴라이어빌리티", "Analytics": "애널리틱스",
    "Collector": "컬렉터", "ClickHouse": "클릭하우스", "Express": "익스프레스",
    "Explore": "익스플로어", "Trace": "트레이스", "Skills": "스킬즈",
    "MCP": "엠 씨 피", "TTFT": "티 티 에프 티", "API": "에이 피 아이",
    "AWS": "에이 더블유 에스", "UTC": "유 티 씨",
}
PATTERN = re.compile(r"(?<![A-Za-z])(" + "|".join(re.escape(k) for k in sorted(ALIASES, key=len, reverse=True)) + r")(?![A-Za-z])")
sha = lambda data: hashlib.sha256(data).hexdigest()


def text_ssml(text):
    return PATTERN.sub(lambda match: '<sub alias="' + ALIASES[match[0]] + '">' + match[0] + '</sub>', escape(text))


def probe(path):
    raw = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], text=True)
    return float(json.loads(raw)["format"]["duration"])


def main():
    for command in ("aws", "ffmpeg", "ffprobe"):
        if not shutil.which(command):
            raise SystemExit("Required executable is missing: " + command)
    script_bytes = (ROOT / "script.json").read_bytes()
    script = json.loads(script_bytes)
    old_file = ROOT / "audio.json"
    old = {clip["id"]: clip for clip in json.loads(old_file.read_text()).get("clips", [])} if old_file.exists() else {}
    audio_dir = ROOT / "audio"
    audio_dir.mkdir(exist_ok=True)

    def generate(scene):
        if not re.fullmatch(r"[a-z0-9-]+", scene["id"]):
            raise ValueError("Invalid scene ID")
        speech = '<speak><prosody rate="' + script["speech_rate"] + '">' + '<break time="120ms"/>'.join(
            '<mark name="s' + str(i) + '"/>' + text_ssml(text) for i, text in enumerate(scene["segments"])) + '</prosody></speak>'
        source_hash = sha(json.dumps({"ssml": speech, "voice": script["voice"], "engine": script["engine"],
            "region": script["region"], "sample_rate": script["sample_rate"]}, ensure_ascii=False, sort_keys=True).encode())
        target = audio_dir / (scene["id"] + ".mp3")
        receipt = audio_dir / (scene["id"] + ".receipt.json")
        cached = old.get(scene["id"]) or (json.loads(receipt.read_text()) if receipt.exists() else None)
        valid_audio = cached and cached.get("source_sha256") == source_hash and target.exists() and sha(target.read_bytes()) == cached["sha256"]
        if valid_audio and cached.get("marks"):
            print(scene["id"] + ": verified cached audio", flush=True)
            return cached
        with tempfile.TemporaryDirectory(prefix="tour-polly-") as directory:
            scratch = Path(directory)
            text_file = scratch / "speech.ssml"
            text_file.write_text(speech)
            common = ["aws", "polly", "synthesize-speech", "--region", script["region"], "--engine", script["engine"],
                "--voice-id", script["voice"], "--text-type", "ssml", "--text", "file://" + str(text_file),
                "--query", "ContentType", "--output", "text", "--no-cli-pager"]
            if not valid_audio:
                raw = scratch / "speech.mp3"
                subprocess.run(common + ["--sample-rate", str(script["sample_rate"]), "--output-format", "mp3", str(raw)], check=True, stdout=subprocess.DEVNULL)
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", "loudnorm=I=-18:TP=-2:LRA=7",
                    "-ar", str(script["sample_rate"]), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", str(target)], check=True)
                cached = {"id": scene["id"], "path": "audio/" + target.name, "source_sha256": source_hash,
                    "sha256": sha(target.read_bytes()), "bytes": target.stat().st_size,
                    "duration_seconds": probe(target), "generated_at": datetime.now(timezone.utc).isoformat()}
                receipt.write_text(json.dumps(cached, indent=2) + "\n")
            marks_file = scratch / "marks.jsonl"
            # The following named option terminates the CLI's variadic mark-type list.
            subprocess.run(common + ["--speech-mark-types", "ssml", "--output-format", "json", str(marks_file)], check=True, stdout=subprocess.DEVNULL)
            marks = [json.loads(line) for line in marks_file.read_text().splitlines() if line.strip()]
            marks = [{"segment": int(mark["value"][1:]), "time_seconds": mark["time"] / 1000} for mark in marks if mark.get("type") == "ssml"]
            assert [m["segment"] for m in marks] == list(range(len(scene["segments"])))
            duration = cached["duration_seconds"]
            assert duration > marks[-1]["time_seconds"]
        result = {**cached, "marks": marks}
        receipt.write_text(json.dumps(result, indent=2) + "\n")
        print(scene["id"] + ": " + str(round(duration, 3)) + " seconds", flush=True)
        return result

    # Each finished clip has a receipt even if a later provider request fails.
    clips = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(generate, scene) for scene in script["scenes"]]
        try:
            for job in jobs:
                clip = job.result()
                clips.append(clip)
                old_file.write_text(json.dumps({"script_sha256": sha(script_bytes), "provider": script["provider"],
                    "voice": script["voice"], "engine": script["engine"], "clips": clips}, indent=2) + "\n")
        except Exception:
            for job in jobs:
                job.cancel()
            raise

    fps = script["fps"]
    lead = math.ceil(script["lead_seconds"] * fps)
    tail = math.ceil(script["tail_seconds"] * fps)
    start = 0
    scenes = []
    for scene, clip in zip(script["scenes"], clips):
        duration_frames = max(10 * fps, lead + math.ceil(clip["duration_seconds"] * fps) + tail)
        scenes.append({"id": scene["id"], "start_frame": start, "duration_frames": duration_frames,
            "speech_start_frame": start + lead, "speech_duration_seconds": clip["duration_seconds"], "marks": clip["marks"]})
        start += duration_frames
    (ROOT / "timing.json").write_text(json.dumps({"fps": fps, "duration_frames": start, "duration_seconds": start / fps,
        "script_sha256": sha(script_bytes), "scenes": scenes}, indent=2) + "\n")

    # Original deterministic pad, generated once per 48-second cycle and repeated.
    rate = script["sample_rate"]
    frequencies = ((130.8128, 164.8138, 195.9977), (110, 130.8128, 164.8138),
        (87.3071, 110, 130.8128), (97.9989, 123.4708, 146.8324))
    cycle = array("h")
    for index in range(48 * rate):
        time = index / rate
        position = time % 12
        envelope = min(1, position / 1.5, (12 - position) / 1.5)
        value = sum(math.sin(2 * math.pi * frequency * time) + .15 * math.sin(4 * math.pi * frequency * time)
            for frequency in frequencies[int(time // 12)])
        cycle.append(round(value * envelope * 1800))
    total = math.ceil(start / fps * rate)
    samples = (cycle * (total // len(cycle) + 1))[:total]
    if sys.byteorder != "little":
        samples.byteswap()
    with tempfile.TemporaryDirectory(prefix="tour-score-") as directory:
        wav = Path(directory) / "score.wav"
        with wave.open(str(wav), "wb") as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(rate); output.writeframes(samples.tobytes())
        bed = audio_dir / "background.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-af", "highpass=f=70,lowpass=f=550,equalizer=f=300:t=q:w=0.8:g=-5",
            "-c:a", "libmp3lame", "-b:a", "96k", str(bed)], check=True)
    data = json.loads(old_file.read_text())
    data["music"] = {"path": "audio/background.mp3", "duration_seconds": probe(bed), "bytes": bed.stat().st_size,
        "sha256": sha(bed.read_bytes()), "source": "Original deterministic sine-pad score; low-pass and presence cut leave room for narration."}
    data["normalization"] = "Speech: loudnorm I=-18, TP=-2, LRA=7. Music is additionally ducked in the audio composition."
    old_file.write_text(json.dumps(data, indent=2) + "\n")
    print("Total timeline: " + str(round(start / fps, 3)) + " seconds", flush=True)


if __name__ == "__main__":
    main()
