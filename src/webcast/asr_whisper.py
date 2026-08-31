#!/usr/bin/env python3
"""Transcribe audio with faster-whisper; emit JSON lines {start, end, text}.

Usage:
  asr_whisper.py --audio path.wav [--model base] [--device cpu] [--compute-type int8]
"""

from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True)
    p.add_argument("--model", default="base")
    p.add_argument("--device", default="cpu")
    p.add_argument("--compute-type", default="int8")
    p.add_argument("--language", default="en")
    p.add_argument("--vad", action="store_true", default=True)
    p.add_argument("--no-vad", action="store_true")
    args = p.parse_args()
    vad = False if args.no_vad else args.vad

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper not installed. From cue root:\n"
            "  python3 -m venv .venv-webcast\n"
            "  .venv-webcast/bin/pip install faster-whisper\n",
            file=sys.stderr,
        )
        return 2

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
    )
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        vad_filter=vad,
        beam_size=1,
        best_of=1,
    )
    meta = {
        "type": "meta",
        "language": getattr(info, "language", args.language),
        "duration": getattr(info, "duration", None),
    }
    print(json.dumps(meta), flush=True)
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        print(
            json.dumps(
                {
                    "type": "segment",
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": text,
                }
            ),
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
