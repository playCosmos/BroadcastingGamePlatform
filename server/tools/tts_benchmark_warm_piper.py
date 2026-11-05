#!/usr/bin/env python3
"""CI-only real Piper warm-model baseline, never used in production."""
import io
import resource
import statistics
import sys
import time
import wave
from piper import PiperVoice

if len(sys.argv) != 2:
    raise SystemExit("expected pinned local ONNX path")
model = sys.argv[1]
started = time.monotonic_ns()
voice = PiperVoice.load(model)
load_ms = round((time.monotonic_ns() - started) / 1_000_000)
samples = []
for i in range(5):
    text = f"Hello, this is a short speech benchmark sample number {i + 1}."
    memory = io.BytesIO()
    start = time.monotonic_ns()
    with wave.open(memory, "wb") as wav:
        if hasattr(voice, "synthesize_wav"):
            voice.synthesize_wav(text, wav)
        else:
            voice.synthesize(text, wav)
    elapsed = round((time.monotonic_ns() - start) / 1_000_000)
    audio = memory.getvalue()
    if len(audio) < 1000 or audio[:4] != b"RIFF":
        raise RuntimeError("warm model synthesis produced invalid WAV")
    samples.append(elapsed)
ordered = sorted(samples)
print("PIPER_WARM_MODEL_PERF samples=5"
      f" load_ms={load_ms}"
      f" first_ms={samples[0]}"
      f" median_ms={ordered[2]}"
      f" p95_ms={ordered[4]}"
      f" mean_ms={round(statistics.mean(samples))}"
      f" max_rss_kib={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}")
