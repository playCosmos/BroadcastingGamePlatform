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
# Explicit override is useful for Conda/Miniforge or an isolated Python install.
# Check a supported interpreter before touching upstream, models or virtualenvs.
CHECK_PYTHON_ONLY=0
case "${1:-}" in
  --check-python) CHECK_PYTHON_ONLY=1; shift ;;
  "") ;;
  *) echo "Usage: bash setup.sh [--check-python]" >&2; exit 2 ;;
esac
if [[ $# -ne 0 ]]; then
  echo "Usage: bash setup.sh [--check-python]" >&2
  exit 2
fi

select_python() {
  local candidate
  local -a candidates=()
  if [[ -n "${GC_TTS_PYTHON:-}" ]]; then
    candidates=("$GC_TTS_PYTHON")
  else
    # Prefer an activated Conda interpreter; otherwise find another installed
    # supported Python, without changing the system Python or Conda base.
    candidates=(python python3.12 python3.11 python3)
  fi
  for candidate in "${candidates[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; sys.exit(0 if sys.version_info[:2] in {(3, 11), (3, 12)} else 1)' >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      echo "[setup] selected Python: $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"
      return 0
    fi
  done
  echo "ERROR: no supported Python 3.11 or 3.12 interpreter found." >&2
  echo "       Currently selected: $(python3 --version 2>&1 || true)" >&2
  echo "       Install/activate a separate Python without changing Conda base." >&2
  if command -v conda >/dev/null 2>&1; then
    echo "       conda create -n gamecenter-tts-py312 python=3.12 -y" >&2
    echo "       conda activate gamecenter-tts-py312" >&2
  else
    echo "       Ubuntu 24.04: sudo apt install -y python3.12 python3.12-venv" >&2
  fi
  echo "       Then: bash setup.sh" >&2
  echo "       Optional: GC_TTS_PYTHON=/path/to/python3.12 bash setup.sh" >&2
  return 2
}
select_python

if [[ "$CHECK_PYTHON_ONLY" == 1 ]]; then
  echo "[setup] Python interpreter check passed (no dependencies installed)"
  exit 0
fi
if ! command -v git >/dev/null || ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "ERROR: prerequisites: sudo apt update && sudo apt install -y git ffmpeg python3-venv python3-dev build-essential ninja-build libsndfile1" >&2
  exit 2
fi
if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
  echo "ERROR: selected Python lacks venv support; install matching python3.12-venv or use Conda Python 3.12." >&2
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

if [[ -e "$ROOT/.venv" && ! -f "$ROOT/.venv/bin/python" ]]; then
  echo "ERROR: incomplete .venv exists. Inspect/rename it manually; refusing to overwrite." >&2
  exit 2
fi
if [[ ! -f "$ROOT/.venv/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$ROOT/.venv"
fi
PY="$ROOT/.venv/bin/python"
if ! "$PY" -c 'import sys; assert sys.version_info[:2] in {(3, 11), (3, 12)} and sys.prefix != sys.base_prefix' >/dev/null 2>&1; then
  echo "ERROR: existing .venv is not a Python 3.11/3.12 virtualenv." >&2
  echo "       Rename .venv to preserve it, then rerun bash setup.sh." >&2
  exit 2
fi
"$PY" -m pip install --upgrade "pip<26" wheel setuptools
# PyTorch CUDA wheels bundle the required userspace CUDA libraries.
"$PY" -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
"$PY" -m pip install -e "$UPSTREAM" "tensorboard>=2.16,<3" "huggingface-hub>=0.34,<1.0"

if ! command -v nvcc >/dev/null 2>&1 && [[ -x /usr/local/cuda-12.8/bin/nvcc ]]; then
  export CUDA_HOME=/usr/local/cuda-12.8
  export PATH="$CUDA_HOME/bin:$PATH"
fi
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
