#!/usr/bin/env python3
"""Explicit, revision-recorded Hugging Face downloads; never runs during setup."""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
MODEL_NAMES = {
    "0.6B": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    "1.7B": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
}
TOKENIZER = "Qwen/Qwen3-TTS-Tokenizer-12Hz"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", choices=tuple(MODEL_NAMES), default="0.6B")
    parser.add_argument("--tokenizer-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        from huggingface_hub import HfApi, snapshot_download
    except ImportError:
        print("Install training environment with setup.sh first", file=sys.stderr)
        return 2
    from os import environ
    environ.setdefault("HF_HOME", str(ROOT / "cache/huggingface"))
    targets = [TOKENIZER]
    if not args.tokenizer_only:
        targets.append(MODEL_NAMES[args.size])
    for repo_id in targets:
        target = ROOT / "models" / repo_id.split("/")[-1]
        target.mkdir(parents=True, exist_ok=True)
        api = HfApi()
        revision = api.model_info(repo_id=repo_id).sha
        print(f"[download] {repo_id} revision {revision} -> {target}")
        snapshot_download(
            repo_id=repo_id, revision=revision, local_dir=str(target),
        )
        (target / ".gamecenter-revision.json").write_text(json.dumps(
            {"repository": repo_id, "revision": revision},
            indent=2) + "\n", encoding="utf-8")
        if not (target / "config.json").exists():
            raise RuntimeError(f"model configuration missing at {target}")
    print("[download] Complete. Weights are local and git-ignored.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
