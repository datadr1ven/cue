#!/usr/bin/env python3
"""Batch-score vision frames with OpenCV (local or AWS Graviton).

Same code path everywhere — contest AWS story is: sync frames to S3, run
this on an arm64/Graviton instance (or any EC2), sync scores.jsonl back.

  # local / on-instance
  python batch_score.py --run-dir /data/runs/<id> --out /data/runs/<id>/scores.jsonl
  python batch_score.py --frames-dir /data/runs/<id>/vision/frames --out scores.jsonl

Emits JSONL: one row per frame with primary, rank, scores, features.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

_VIS = Path(__file__).resolve().parent
if str(_VIS) not in sys.path:
    sys.path.insert(0, str(_VIS))

from score_frame import _score  # noqa: E402


def _iter_frames(frames_dir: Path, actions: set[str] | None) -> list[Path]:
    out: list[Path] = []
    for p in sorted(frames_dir.iterdir()):
        if p.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        if actions:
            act = p.name.rsplit("_", 1)[0]
            if act not in actions:
                continue
        out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run-dir", type=Path, help="Archive run dir (uses vision/frames)")
    ap.add_argument("--frames-dir", type=Path, help="Explicit frames directory")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output JSONL (default: <run>/vision/scores.jsonl or ./scores.jsonl)",
    )
    ap.add_argument(
        "--actions",
        default="",
        help="Comma-separated actionId filter (default: all)",
    )
    ap.add_argument(
        "--summary-json",
        type=Path,
        default=None,
        help="Optional summary JSON next to out",
    )
    args = ap.parse_args()

    if args.run_dir:
        run_dir = args.run_dir.expanduser().resolve()
        frames_dir = run_dir / "vision" / "frames"
        default_out = run_dir / "vision" / "scores.jsonl"
        run_id = run_dir.name
    elif args.frames_dir:
        frames_dir = args.frames_dir.expanduser().resolve()
        default_out = Path("scores.jsonl").resolve()
        run_id = frames_dir.parent.parent.name if frames_dir.parent.name == "vision" else frames_dir.name
        run_dir = None
    else:
        print("Need --run-dir or --frames-dir", file=sys.stderr)
        return 1

    if not frames_dir.is_dir():
        print(f"No frames dir: {frames_dir}", file=sys.stderr)
        return 1

    actions = {a.strip() for a in args.actions.split(",") if a.strip()} or None
    frames = _iter_frames(frames_dir, actions)
    out_path = (args.out or default_out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    import cv2

    t0 = time.perf_counter()
    ok = fail = 0
    ranks: list[float] = []
    with out_path.open("w", encoding="utf-8") as f:
        for p in frames:
            s = _score(p)
            row = {
                "runId": run_id,
                "frame": str(p.relative_to(frames_dir.parent.parent) if run_dir else p.name),
                "file": p.name,
                "ok": bool(s.get("ok")),
                "primary": s.get("primary"),
                "rank": s.get("rank"),
                "scores": s.get("scores"),
                "features": s.get("features"),
            }
            if run_dir:
                try:
                    row["frame"] = str(p.relative_to(run_dir))
                except ValueError:
                    row["frame"] = f"vision/frames/{p.name}"
            else:
                row["frame"] = p.name
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            if s.get("ok"):
                ok += 1
                if s.get("rank") is not None:
                    ranks.append(float(s["rank"]))
            else:
                fail += 1

    elapsed = time.perf_counter() - t0
    per = (elapsed / max(ok + fail, 1)) * 1000
    summary = {
        "ok": True,
        "runId": run_id,
        "frames": ok + fail,
        "scored": ok,
        "failed": fail,
        "out": str(out_path),
        "elapsedSec": round(elapsed, 3),
        "msPerFrame": round(per, 2),
        "opencv": cv2.__version__,
        "meanRank": round(sum(ranks) / len(ranks), 4) if ranks else None,
        "host": __import__("socket").gethostname(),
        "platform": __import__("platform").platform(),
        "machine": __import__("platform").machine(),
    }
    summary_path = args.summary_json
    if summary_path is None:
        summary_path = out_path.with_suffix(".summary.json")
    summary_path = summary_path.expanduser().resolve()
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
