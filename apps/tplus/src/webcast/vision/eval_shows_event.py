#!/usr/bin/env python3
"""Evaluate shows-event gate against shows_event.jsonl gold.

Uses score_frame heuristics as a weak proxy:
  - predicted yes if primary not in {hud_heavy, low_value} and rank >= --tau
  - report precision/recall for showsEvent=yes (precision-first product metric)

  python eval_shows_event.py --gold path/to/shows_event.jsonl --run-dir path/to/run
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
    ap.add_argument("--gold", type=Path, required=True)
    ap.add_argument("--run-dir", type=Path, help="Single run dir (frames under vision/frames)")
    ap.add_argument("--tau", type=float, default=0.35, help="Min rank to predict yes")
    args = ap.parse_args()

    rows = [json.loads(l) for l in args.gold.read_text().splitlines() if l.strip()]
    # only binary yes/no
    rows = [r for r in rows if r.get("showsEvent") in ("yes", "no")]
    if not rows:
        print("No yes/no rows in gold", file=sys.stderr)
        return 1

    tp = fp = tn = fn = 0
    skip = 0
    for r in rows:
        run = args.run_dir
        if run is None:
            # gold may mix runs — resolve relative to tplus-webcast/runs
            cand = Path("tplus-webcast/runs") / r["runId"]
            run = cand if cand.is_dir() else None
        if run is None:
            skip += 1
            continue
        path = run / r["frame"]
        if not path.is_file():
            skip += 1
            continue
        s = _score(path)
        pred_yes = bool(s.get("ok")) and s.get("primary") not in {
            "hud_heavy",
            "low_value",
        } and float(s.get("rank") or 0) >= args.tau
        gold_yes = r["showsEvent"] == "yes"
        if pred_yes and gold_yes:
            tp += 1
        elif pred_yes and not gold_yes:
            fp += 1
        elif (not pred_yes) and (not gold_yes):
            tn += 1
        else:
            fn += 1

    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    out = {
        "ok": True,
        "n": tp + fp + tn + fn,
        "skipped": skip,
        "tau": args.tau,
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "precisionYes": round(prec, 4),
        "recallYes": round(rec, 4),
        "note": "Precision on yes = false-post rate inverse; product optimizes this first.",
    }
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
