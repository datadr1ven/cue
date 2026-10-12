#!/usr/bin/env python3
"""Evaluate score_frame rank against human picks.jsonl.

  python eval_picks.py --run-dir ~/cue/tplus-webcast/runs/<id>
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run-dir", type=Path, required=True)
    args = ap.parse_args()
    run = args.run_dir.expanduser().resolve()
    picks_path = run / "vision" / "picks.jsonl"
    if not picks_path.is_file():
        print(f"missing {picks_path}", file=sys.stderr)
        return 1

    picks = [
        json.loads(l) for l in picks_path.read_text(encoding="utf-8").splitlines() if l.strip()
    ]
    top1 = top3 = top10 = n = 0
    rows = []
    for pk in picks:
        act = pk["actionId"]
        best = (run / pk["frame"]).resolve()
        if not best.is_file():
            print(f"missing frame {best}", file=sys.stderr)
            continue
        scored = []
        for p in sorted((run / "vision" / "frames").glob(f"{act}_*.jpg")):
            s = _score(p)
            if s.get("ok"):
                scored.append((s["rank"], p, s.get("primary")))
        scored.sort(reverse=True)
        idx = next(i for i, (_, p, _) in enumerate(scored) if p.resolve() == best)
        n += 1
        if idx == 0:
            top1 += 1
        if idx < 3:
            top3 += 1
        if idx < 10:
            top10 += 1
        rows.append(
            {
                "actionId": act,
                "pick": best.name,
                "index": idx,
                "n": len(scored),
                "modelTop": scored[0][1].name if scored else None,
                "modelTopPrimary": scored[0][2] if scored else None,
                "pickRank": scored[idx][0],
                "topRank": scored[0][0] if scored else None,
            }
        )
        print(
            f"  {act:22} #{idx+1}/{len(scored)}  pick={best.name}  "
            f"model#1={scored[0][1].name} ({scored[0][2]})"
        )

    summary = {
        "ok": True,
        "runId": run.name,
        "n": n,
        "top1": top1,
        "top3": top3,
        "top10": top10,
        "top1Rate": round(top1 / max(n, 1), 4),
        "top3Rate": round(top3 / max(n, 1), 4),
        "top10Rate": round(top10 / max(n, 1), 4),
        "rows": rows,
    }
    print(json.dumps({k: summary[k] for k in summary if k != "rows"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
