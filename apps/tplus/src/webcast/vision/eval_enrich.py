#!/usr/bin/env python3
"""Rank frames for a milestone emit window (offline enrichment stub).

Looks under:
  <run>/vision/frames/   preferred (dense extract)
  <run>/frames/          fallback (emit stills only)

Usage:
  python eval_enrich.py --run-dir .../runs/<id> --action seco
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_VIS = Path(__file__).resolve().parent
if str(_VIS) not in sys.path:
    sys.path.insert(0, str(_VIS))

from score_frame import _score  # noqa: E402


def _candidate_dirs(run_dir: Path) -> list[Path]:
    out = []
    for rel in ("vision/frames", "frames"):
        p = run_dir / rel
        if p.is_dir():
            out.append(p)
    return out


def _list_images(dirs: list[Path], action: str | None) -> list[Path]:
    exts = {".jpg", ".jpeg", ".png", ".webp"}
    files: list[Path] = []
    for d in dirs:
        for p in sorted(d.iterdir()):
            if p.suffix.lower() not in exts:
                continue
            if action and action.lower() not in p.stem.lower():
                # keep non-matching only if this dir has few files (emit stills)
                continue
            files.append(p)
    if files:
        return files
    # fallback: all images if action filter emptied the set
    for d in dirs:
        for p in sorted(d.iterdir()):
            if p.suffix.lower() in exts:
                files.append(p)
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument(
        "--action",
        default=None,
        help="Prefer frames whose filename contains this actionId (e.g. seco)",
    )
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()

    run_dir = args.run_dir.expanduser().resolve()
    if not run_dir.is_dir():
        print(f"run dir not found: {run_dir}", file=sys.stderr)
        return 1

    dirs = _candidate_dirs(run_dir)
    if not dirs:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "no frames/ or vision/frames/ under run",
                    "hint": "Extract a dense frame pack first (see VISION-ENRICHMENT.md)",
                },
                indent=2,
            )
        )
        return 1

    images = _list_images(dirs, args.action)
    scored = [_score(p) for p in images]
    scored = [s for s in scored if s.get("ok")]
    scored.sort(key=lambda s: s.get("rank", 0.0), reverse=True)

    naive = None
    # Historical emit still: frames/<action>.jpg if present
    if args.action:
        for ext in (".jpg", ".jpeg", ".png"):
            cand = run_dir / "frames" / f"{args.action}{ext}"
            if cand.is_file():
                naive = _score(cand)
                break

    result = {
        "ok": True,
        "runDir": str(run_dir),
        "action": args.action,
        "candidates": len(scored),
        "naiveEmitStill": naive,
        "top": scored[: args.top],
        "pick": scored[0] if scored else None,
    }
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
