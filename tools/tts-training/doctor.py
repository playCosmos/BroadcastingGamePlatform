#!/usr/bin/env python3
"""Read-only GPU/training environment check. No downloads or model execution."""
import argparse
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
PIN = "022e286b98fbec7e1e916cb940cdf532cd9f488e"


def check_runtime(require_ready=False):
    problems = []
    warnings = []
    facts = {"python": sys.version.split()[0], "platform": sys.platform}
    for command in ("git", "ffmpeg", "ffprobe", "nvidia-smi", "nvcc"):
        facts[command] = shutil.which(command) or None
    for command in ("git", "ffmpeg", "ffprobe"):
        if not facts[command]:
            problems.append("missing command: " + command)
    if sys.platform != "linux":
        problems.append("training requires WSL2 Ubuntu or native Linux")
    if sys.version_info[:2] not in {(3, 11), (3, 12)}:
        problems.append("Python 3.11/3.12 required")
    upstream = ROOT / "upstream"
    if (upstream / ".git").exists():
        result = subprocess.run(
            ["git", "-C", str(upstream), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=False,
        )
        facts["upstream_sha"] = result.stdout.strip() if result.returncode == 0 else None
        if facts["upstream_sha"] != PIN:
            problems.append("upstream must be checked out at pinned SHA")
    else:
        problems.append("missing upstream source: run setup.sh")
    torch_spec = importlib.util.find_spec("torch")
    if torch_spec is None:
        problems.append("PyTorch not installed: run setup.sh")
    else:
        import torch
        facts["torch_version"] = torch.__version__
        facts["torch_cuda_runtime"] = torch.version.cuda
        facts["cuda_available"] = bool(torch.cuda.is_available())
        if not facts["cuda_available"]:
            problems.append("CUDA unavailable: inspect WSL driver, nvidia-smi and torch wheel")
        else:
            props = torch.cuda.get_device_properties(0)
            facts["gpu"] = props.name
            facts["vram_gib"] = round(props.total_memory / (1024 ** 3), 2)
            facts["bf16_supported"] = torch.cuda.is_bf16_supported()
            if not facts["bf16_supported"]:
                problems.append("selected GPU lacks bf16 support")
    for name in ("qwen_tts", "accelerate", "soundfile", "flash_attn"):
        facts[name] = importlib.util.find_spec(name) is not None
        if not facts[name]:
            if name == "flash_attn":
                problems.append("flash-attn missing: official SFT requires FlashAttention 2")
            else:
                problems.append("missing Python module: " + name)
    if facts["nvcc"] is None:
        warnings.append("nvcc not on PATH: FlashAttention cannot compile from source")
    if (ROOT / "data/raw").exists() and not (ROOT / "data/prepared/train_raw.jsonl").exists():
        warnings.append("no prepared training JSONL; run prepare_dataset.py after adding audio")
    facts["problems"] = problems
    facts["warnings"] = warnings
    facts["ready"] = len(problems) == 0
    return facts, (1 if require_ready and problems else 0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-ready", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    facts, status = check_runtime(args.require_ready)
    if args.json:
        print(json.dumps(facts, ensure_ascii=False, indent=2))
    else:
        print("Qwen3-TTS trainer environment")
        for key, value in facts.items():
            if key not in ("problems", "warnings"):
                print(f"  {key}: {value}")
        for message in facts["warnings"]:
            print("  WARNING: " + message)
        for message in facts["problems"]:
            print("  BLOCKED: " + message)
        if facts["ready"]:
            print("  READY: environment checks passed (training quality not tested)")
    return status


if __name__ == "__main__":
    sys.exit(main())
