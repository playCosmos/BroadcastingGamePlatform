#!/usr/bin/env bash
# Usage: bash train.sh [0.6B|1.7B]. Explicit model training only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SIZE="0.6B"
if [[ $# -gt 0 ]]; then SIZE="$1"; fi
if [[ "$SIZE" != "0.6B" && "$SIZE" != "1.7B" ]]; then
  echo "ERROR: select 0.6B or 1.7B" >&2; exit 2
fi
PY="$ROOT/.venv/bin/python"
if [[ ! -x "$PY" ]]; then echo "ERROR: run setup.sh first" >&2; exit 2; fi
"$PY" "$ROOT/doctor.py" --require-ready

TRAIN_RAW="$ROOT/data/prepared/train_raw.jsonl"
TRAIN_CODES="$ROOT/data/prepared/train_with_codes.jsonl"
TOKENIZER="$ROOT/models/Qwen3-TTS-Tokenizer-12Hz"
BASE="$ROOT/models/Qwen3-TTS-12Hz-$SIZE-Base"
if [[ ! -s "$TRAIN_RAW" ]]; then
  echo "ERROR: train_raw.jsonl not found. Run prepare_dataset.py." >&2; exit 2
fi
if [[ ! -f "$TOKENIZER/config.json" || ! -f "$BASE/config.json" ]]; then
  echo "ERROR: download tokenizer + $SIZE model with fetch_models.py." >&2; exit 2
fi
if [[ -e "$TRAIN_CODES" && "$TRAIN_RAW" -nt "$TRAIN_CODES" ]]; then
  echo "ERROR: training text manifest changed since codec generation." >&2
  echo "Move/remove train_with_codes.jsonl yourself before re-encoding." >&2
  exit 2
fi
if [[ ! -e "$TRAIN_CODES" ]]; then
  echo "[train] Encoding source WAVs using Qwen 12Hz tokenizer..."
  "$PY" "$ROOT/upstream/finetuning/prepare_data.py" \
    --device cuda:0 --tokenizer_model_path "$TOKENIZER" \
    --input_jsonl "$TRAIN_RAW" --output_jsonl "$TRAIN_CODES"
fi

RUN="$ROOT/runs/qwen-$SIZE-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN"
"$PY" -m pip freeze > "$RUN/pip-freeze.txt"
git -C "$ROOT/upstream" rev-parse HEAD > "$RUN/upstream-sha.txt"
SCRIPT="$ROOT/upstream/finetuning/sft_12hz.py"
if [[ "$SIZE" == "0.6B" ]]; then
  echo "WARNING: 0.6B official training has reported dimension/noise issues."
  echo "Using a revision-checked text projection fix; output quality must be listened to."
  SCRIPT="$RUN/sft_06b_experimental.py"
  "$PY" "$ROOT/patch_sft.py" \
    --source "$ROOT/upstream/finetuning/sft_12hz.py" --target "$SCRIPT"
else
  echo "WARNING: full 1.7B AdamW fine-tuning can exceed 24GiB VRAM."
fi
SPEAKER="character_1"
if [[ -n "$SPEAKER" ]] && [[ ! "$SPEAKER" =~ ^[A-Za-z][A-Za-z0-9_]*$ ]]; then
  echo "ERROR: invalid speaker name" >&2; exit 2
fi
export HF_HOME="$ROOT/cache/huggingface"
export PYTHONPATH="$ROOT/upstream/finetuning"
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"
cd "$ROOT"
echo "[train] checkpoints -> $RUN/checkpoints"
echo "[train] stopping after first two epochs for initial quality evaluation"
"$PY" "$SCRIPT" \
  --init_model_path "$BASE" \
  --output_model_path "$RUN/checkpoints" \
  --train_jsonl "$TRAIN_CODES" \
  --batch_size 1 --lr 2e-6 --num_epochs 2 \
  --speaker_name "$SPEAKER" 2>&1 | tee "$RUN/train.log"
