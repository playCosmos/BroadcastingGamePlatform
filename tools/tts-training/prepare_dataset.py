#!/usr/bin/env python3
"""Build deterministic single-speaker Qwen3-TTS manifests from local recordings.

No ASR guessing or transcript rewriting. Audio/transcripts stay local.
"""
import argparse
import csv
import hashlib
import json
import pathlib
import random
import shutil
import subprocess
import sys
import wave

ROOT = pathlib.Path(__file__).resolve().parent
EXTENSIONS = {".wav", ".flac", ".mp3", ".m4a", ".ogg"}
SAMPLE_RATE = 24000


def entries_from_csv(source: pathlib.Path, manifest: pathlib.Path):
    source = source.resolve(strict=True)
    manifest = manifest.resolve(strict=True)
    if not manifest.is_file():
        raise ValueError("CSV manifest is not a file")
    entries = []
    seen = set()
    with manifest.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or not {"file", "text"}.issubset(reader.fieldnames):
            raise ValueError('CSV header must contain "file,text"')
        for line, row in enumerate(reader, start=2):
            name = (row.get("file") or "").strip()
            text = (row.get("text") or "").strip()
            if not name or not text:
                raise ValueError(f"line {line}: file and transcript must be nonempty")
            if len(text) > 1500:
                raise ValueError(f"line {line}: transcript over 1500 characters")
            path = (source / name).resolve(strict=True)
            if not path.is_relative_to(source):
                raise ValueError(f"line {line}: audio path must remain inside source directory")
            if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
                raise ValueError(f"line {line}: unsupported audio type")
            if path in seen:
                raise ValueError(f"line {line}: duplicate audio recording")
            seen.add(path)
            entries.append({"path": path, "text": text})
    if len(entries) < 4:
        raise ValueError("need at least four independently transcribed utterances")
    return entries


def split_entries(entries, ratio, seed):
    if not (0 < ratio <= 0.3):
        raise ValueError("validation ratio must be between 0 and 0.3")
    ids = list(range(len(entries)))
    random.Random(seed).shuffle(ids)
    validation_count = max(1, round(len(ids) * ratio))
    validation_ids = set(ids[:validation_count])
    training = [x for i, x in enumerate(entries) if i not in validation_ids]
    validation = [x for i, x in enumerate(entries) if i in validation_ids]
    return training, validation


def is_pcm24k(path):
    if path.suffix.lower() != ".wav":
        return False
    try:
        with wave.open(str(path), "rb") as wav:
            return (wav.getnchannels() == 1 and wav.getsampwidth() == 2
                    and wav.getframerate() == SAMPLE_RATE
                    and wav.getcomptype() == "NONE")
    except (OSError, EOFError, wave.Error):
        return False


def convert_audio(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if is_pcm24k(source):
        shutil.copyfile(source, destination)
    else:
        if shutil.which("ffmpeg") is None:
            raise ValueError("ffmpeg is needed to convert audio to 24 kHz mono WAV")
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
             "-y", "-i", str(source), "-vn", "-map", "0:a:0",
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le",
             str(destination)],
            capture_output=True, text=True, timeout=120, check=False,
        )
        if result.returncode:
            raise ValueError("failed converting " + source.name + ": "
                             + result.stderr[-450:])
    with wave.open(str(destination), "rb") as stream:
        if (stream.getnchannels(), stream.getsampwidth(),
                stream.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError("incorrect converted WAV format for " + source.name)
        duration = stream.getnframes() / SAMPLE_RATE
    if duration < 1.0 or duration > 20.0:
        raise ValueError(f"{source.name}: {duration:.1f}s; split into 1-20s utterances with accurate transcripts")
    return duration


def build_dataset(source, manifest, output, ratio=0.1, seed=42, dry_run=False):
    source = pathlib.Path(source).resolve(strict=True)
    output = pathlib.Path(output).resolve()
    if not source.is_dir():
        raise ValueError("source is not a directory")
    if output == source or source in output.parents:
        raise ValueError("output must be outside the raw source directory")
    items = entries_from_csv(source, pathlib.Path(manifest))
    train, val = split_entries(items, ratio, seed)
    if output.exists() and any(output.iterdir()):
        raise ValueError("output directory is not empty; choose a new path (never overwrites existing data)")
    if dry_run:
        return {"recordings": len(items), "train": len(train), "validation": len(val),
                "dry_run": True}
    output.mkdir(parents=True, exist_ok=True)
    mapping = {}
    total_seconds = 0.0
    for i, item in enumerate(items):
        target = output / "wav" / f"utt_{i:05d}.wav"
        duration = convert_audio(item["path"], target)
        total_seconds += duration
        mapping[item["path"]] = {"audio": str(target.resolve()), "text": item["text"],
                                 "seconds": duration}
    # A single stable training reference is used for all training/validation samples.
    reference_source = min(train, key=lambda x: abs(mapping[x["path"]]["seconds"] - 6))
    reference = mapping[reference_source["path"]]["audio"]
    def write_jsonl(filename, selected):
        with (output / filename).open("x", encoding="utf-8") as out:
            for item in selected:
                record = mapping[item["path"]]
                out.write(json.dumps(
                    {"audio": record["audio"], "text": record["text"],
                     "ref_audio": reference}, ensure_ascii=False) + "\n")
    write_jsonl("train_raw.jsonl", train)
    write_jsonl("validation_raw.jsonl", val)
    summary = {
        "total_utterances": len(items), "train_utterances": len(train),
        "validation_utterances": len(val), "duration_seconds": round(total_seconds, 2),
        "reference_audio": reference, "sample_rate": SAMPLE_RATE,
        "random_seed": seed, "validation_ratio": ratio,
        "transcripts_sha256": hashlib.sha256(
            pathlib.Path(manifest).read_bytes()).hexdigest(),
    }
    (output / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=ROOT / "data/raw")
    parser.add_argument("--manifest", type=pathlib.Path, default=None)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "data/prepared")
    parser.add_argument("--validation-ratio", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    manifest = args.manifest or args.source / "transcripts.csv"
    try:
        result = build_dataset(args.source, manifest, args.output,
                               args.validation_ratio, args.seed, args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if not args.dry_run and result["duration_seconds"] < 600:
            print("WARNING: less than 10 minutes of speech; fine-tuning quality may vary",
                  file=sys.stderr)
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print("Dataset error: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
