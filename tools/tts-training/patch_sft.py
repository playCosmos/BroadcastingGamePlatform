#!/usr/bin/env python3
"""Minimal opt-in 0.6B projection workaround for one pinned upstream revision.

This corrects a known embedding shape mismatch; acoustic quality remains
experimental. NEVER patch arbitrary updated training sources.
"""
import argparse
import ast
import pathlib
import subprocess
import sys

PIN = "022e286b98fbec7e1e916cb940cdf532cd9f488e"
OLD = "input_text_embedding = model.talker.model.text_embedding(input_text_ids) * text_embedding_mask"
NEW = ("input_text_embedding = model.talker.text_projection("
       "model.talker.model.text_embedding(input_text_ids)) * text_embedding_mask")


def make_patched(source, target, pin=PIN):
    source = pathlib.Path(source).resolve(strict=True)
    target = pathlib.Path(target).resolve()
    upstream = source.parent.parent
    rev = subprocess.run(["git", "-C", str(upstream), "rev-parse", "HEAD"],
                         check=True, capture_output=True, text=True).stdout.strip()
    if rev != pin:
        raise ValueError("unsupported Qwen3-TTS source revision; re-review workaround")
    code = source.read_text(encoding="utf-8")
    if code.count(OLD) != 1:
        raise ValueError("expected projection expression missing or duplicated")
    patched = code.replace(OLD, NEW, 1)
    ast.parse(patched)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise ValueError("patched output exists; choose a new output directory")
    target.write_text(patched, encoding="utf-8")
    return target


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--target", type=pathlib.Path, required=True)
    args = parser.parse_args(argv)
    try:
        target = make_patched(args.source, args.target)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("SFT patch blocked: " + str(error), file=sys.stderr)
        return 2
    print(f"[experimental 0.6B] patched local copy: {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
