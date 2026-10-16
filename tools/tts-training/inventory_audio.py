#!/usr/bin/env python3
"""Local voice recording inventory and editable transcript CSV starter.

Does not perform ASR, alter source recordings or upload any data.
"""
import argparse
import csv
import json
import pathlib
import subprocess
import sys
import wave

from prepare_dataset import EXTENSIONS

ROOT = pathlib.Path(__file__).resolve().parent
MIN_SECONDS = 1.0
MAX_SECONDS = 20.0


def probe_audio(path):
    """Return (duration_seconds, sample_rate, channels), or raise ValueError."""
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as wav:
                rate = wav.getframerate()
                if rate <= 0 or wav.getnchannels() <= 0 or wav.getnframes() <= 0:
                    raise ValueError("empty or invalid WAV")
                return wav.getnframes() / rate, rate, wav.getnchannels()
        except (wave.Error, EOFError, OSError) as error:
            # Compressed or float WAVs can be unsupported by stdlib wave.
            pass
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=codec_type,sample_rate,channels,duration",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"ffprobe unavailable or timed out: {type(error).__name__}") from error
    if result.returncode:
        raise ValueError("ffprobe failed (corrupted or unsupported audio)")
    try:
        metadata = json.loads(result.stdout)
        audio_streams = [stream for stream in metadata.get("streams", [])
                         if stream.get("codec_type") == "audio"]
        if not audio_streams:
            raise ValueError("no audio stream")
        stream = audio_streams[0]
        duration = metadata.get("format", {}).get("duration") or stream.get("duration")
        seconds = float(duration)
        rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
        if not (0 < seconds < 24 * 3600 and rate > 0 and channels > 0):
            raise ValueError("invalid duration or audio format")
        return seconds, rate, channels
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        raise ValueError("invalid ffprobe metadata") from error


def inventory(source):
    """Inspect files without reading speech content or changing recordings."""
    source = pathlib.Path(source).resolve(strict=True)
    if not source.is_dir():
        raise ValueError("source is not a directory")
    rows = []
    for file in sorted(source.rglob("*")):
        if file.suffix.lower() not in EXTENSIONS or not file.is_file():
            continue
        actual = file.resolve(strict=True)
        if not actual.is_relative_to(source):
            # Never follow symlinks outside the private recording directory.
            continue
        name = file.relative_to(source).as_posix()
        row = {"file": name}
        try:
            seconds, rate, channels = probe_audio(actual)
            row.update(seconds=round(seconds, 3), sample_rate=rate,
                       channels=channels,
                       status=("SHORT" if seconds < MIN_SECONDS
                               else "LONG" if seconds > MAX_SECONDS else "READY"))
        except ValueError as error:
            row.update(seconds=None, sample_rate=None, channels=None,
                       status="INVALID", problem=str(error))
        rows.append(row)
    return rows


def summarize(rows):
    good = [r for r in rows if r["status"] == "READY"]
    probed = [r for r in rows if r["seconds"] is not None]
    return {
        "recordings": len(rows),
        "ready_clips": len(good),
        "short_clips": sum(r["status"] == "SHORT" for r in rows),
        "long_clips": sum(r["status"] == "LONG" for r in rows),
        "invalid_clips": sum(r["status"] == "INVALID" for r in rows),
        "all_audio_minutes": round(sum(r["seconds"] for r in probed) / 60, 2),
        "ready_audio_minutes": round(sum(r["seconds"] for r in good) / 60, 2),
        "note": "READY only checks duration, not single speaker, transcription, noise or legal rights",
    }


def save_template(rows, destination):
    """Write all recognized clips, blank text; never overwrite an existing CSV."""
    destination = pathlib.Path(destination)
    if destination.exists():
        raise ValueError(f"template exists: {destination}; refusing to overwrite")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("x", newline="", encoding="utf-8-sig") as file:
        writer = csv.writer(file)
        writer.writerow(["file", "text"])
        for row in rows:
            writer.writerow([row["file"], ""])
    return len(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=ROOT / "data/raw")
    parser.add_argument("--write-template", type=pathlib.Path,
                        help="write CSV with blank transcripts (fails if file exists)")
    parser.add_argument("--json", action="store_true", help="include per-file metadata")
    args = parser.parse_args(argv)
    try:
        rows = inventory(args.source)
        summary = summarize(rows)
        print(json.dumps({"summary": summary, "files": rows} if args.json else summary,
                         ensure_ascii=False, indent=2))
        for row in rows:
            if row["status"] != "READY":
                print(f"  {row['status']}: {row['file']} ({row['seconds']} sec)", file=sys.stderr)
        if args.write_template:
            count = save_template(rows, args.write_template)
            print(f"[inventory] transcript template: {args.write_template} ({count} rows)")
        if not rows:
            print("[inventory] no audio found. Place authorized clips under data/raw", file=sys.stderr)
        return 0 if not any(r["status"] == "INVALID" for r in rows) else 2
    except (OSError, ValueError) as error:
        print(f"Inventory error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
