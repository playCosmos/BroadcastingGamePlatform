#!/usr/bin/env python3
"""Evaluate a trusted fine-tuned Qwen3-TTS checkpoint with a fresh sentence."""
import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=pathlib.Path, required=True)
    parser.add_argument("--speaker", default="character_1")
    parser.add_argument("--text", default="안녕하세요. 새로운 목소리 평가 문장입니다.")
    parser.add_argument("--language", default="Korean")
    parser.add_argument("--output", type=pathlib.Path,
                        default=ROOT / "outputs/evaluation.wav")
    args = parser.parse_args(argv)
    path = args.checkpoint.resolve(strict=True)
    if not (path / "config.json").is_file() or not (path / "model.safetensors").is_file():
        parser.error("checkpoint must contain config.json and model.safetensors")
    if not args.text.strip():
        parser.error("text may not be empty")
    try:
        import torch
        import soundfile as sf
        from qwen_tts import Qwen3TTSModel
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU required for this evaluation setup")
        model = Qwen3TTSModel.from_pretrained(
            str(path), device_map="cuda:0", dtype=torch.bfloat16,
            attn_implementation="flash_attention_2")
        waveforms, sample_rate = model.generate_custom_voice(
            text=args.text, speaker=args.speaker, language=args.language)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(args.output), waveforms[0], sample_rate)
    except (ImportError, RuntimeError, ValueError) as exc:
        print(f"Evaluation failed: {exc}", file=sys.stderr)
        return 2
    print(f"[evaluation] WAV: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
