#!/usr/bin/env bash
# Isolated trainer for WSL2 Ubuntu 24.04 or native Ubuntu Linux.
# Never modifies the GameCenter Java server, Windows runtime, or GPU driver.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UPSTREAM="$ROOT/upstream"
PIN="022e286b98fbec7e1e916cb940cdf532cd9f488e"
export HF_HOME="$ROOT/cache/huggingface"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export MAX_JOBS=2

if [[ "$(uname -s)" != Linux ]]; then
  echo "ERROR: run inside WSL2 Ubuntu or native Linux (not Windows PowerShell)." >&2
  exit 2
fi
if [[ "$ROOT" == /mnt/* ]]; then
  echo "WARNING: GPU training is slower on /mnt/c or /mnt/d. Prefer ~/GameCenter." >&2
fi
if ! command -v python3 >/dev/null; then
  echo "ERROR: python3 missing. Install Ubuntu python3 and python3-venv." >&2
  exit 2
fi
if ! command -v git >/dev/null || ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "ERROR: prerequisites: sudo apt update && sudo apt install -y git ffmpeg python3-venv python3-dev build-essential ninja-build libsndfile1" >&2
  exit 2
fi
python3 - <<'PY'
import sys
if sys.version_info[:2] not in {(3, 11), (3, 12)}:
    raise SystemExit("Use Python 3.11 or 3.12 for this pinned environment")
PY
if ! python3 -m venv --help >/dev/null 2>&1; then
  echo "ERROR: python venv support missing; install python3-venv." >&2
  exit 2
fi

mkdir -p "$ROOT/cache" "$ROOT/models" "$ROOT/data/raw" "$ROOT/runs" "$ROOT/logs"
if [[ ! -d "$UPSTREAM/.git" ]]; then
  if [[ -e "$UPSTREAM" ]]; then
    echo "ERROR: upstream folder exists but is not a Git checkout." >&2
    exit 2
  fi
  git clone https://github.com/QwenLM/Qwen3-TTS.git "$UPSTREAM"
fi
actual="$(git -C "$UPSTREAM" rev-parse HEAD)"
if [[ "$actual" != "$PIN" ]]; then
  if [[ -n "$(git -C "$UPSTREAM" status --porcelain)" ]]; then
    echo "ERROR: upstream has local changes; refusing to replace them." >&2
    exit 2
  fi
  git -C "$UPSTREAM" fetch --depth 1 origin "$PIN"
  git -C "$UPSTREAM" checkout --detach "$PIN"
fi
if [[ "$(git -C "$UPSTREAM" rev-parse HEAD)" != "$PIN" ]]; then
  echo "ERROR: upstream revision could not be pinned." >&2
  exit 2
fi

if [[ ! -f "$ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$ROOT/.venv"
fi
PY="$ROOT/.venv/bin/python"
"$PY" -m pip install --upgrade "pip<26" wheel setuptools
# PyTorch CUDA wheels bundle the required userspace CUDA libraries.
"$PY" -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
"$PY" -m pip install -e "$UPSTREAM" "tensorboard>=2.16,<3" "huggingface-hub>=0.34,<1.0"

if command -v nvcc >/dev/null 2>&1; then
  echo "[setup] CUDA toolkit detected; installing FlashAttention (build may take time)."
  "$PY" -m pip install ninja packaging psutil
  "$PY" -m pip install flash-attn --no-build-isolation
else
  echo "WARNING: nvcc not found. Preparation can work, but official SFT requires flash-attn."
  echo "Install NVIDIA CUDA toolkit inside WSL2 (do NOT install Linux GPU drivers) then rerun setup.sh."
fi

"$PY" -m pip freeze > "$ROOT/logs/pip-freeze.txt"
printf '%s\n' "$PIN" > "$ROOT/logs/upstream-commit.txt"
echo "[setup] Python environment prepared at $ROOT/.venv"
"$PY" "$ROOT/doctor.py"
