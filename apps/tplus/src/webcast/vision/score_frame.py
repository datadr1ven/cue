#!/usr/bin/env python3
"""Baseline OpenCV scorer for TPlus webcast frame enrichment (v0 heuristics).

Not a trained model — fast, demoable, and replaceable by DNN later.
Prints JSON: primary label, scores, and a simple "enrichment value" rank key.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

LABELS = (
    "plume_on",
    "plume_off",
    "pad_or_tower",
    "vehicle_air",
    "landing_burn",
    "hud_heavy",
    "low_value",
)

# Higher = prefer as alert still
RANK_WEIGHT = {
    "landing_burn": 1.0,
    "plume_on": 0.95,
    "vehicle_air": 0.85,
    "plume_off": 0.55,
    "pad_or_tower": 0.45,
    "hud_heavy": 0.15,
    "low_value": 0.0,
}


def _score(path: Path) -> dict:
    img = cv2.imread(str(path))
    if img is None:
        return {
            "ok": False,
            "error": f"failed to read {path}",
            "primary": "low_value",
            "scores": {k: 0.0 for k in LABELS},
            "rank": 0.0,
        }

    h, w = img.shape[:2]
    small = cv2.resize(img, (320, int(320 * h / max(w, 1))))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    mean_v = float(np.mean(hsv[:, :, 2]))
    std_gray = float(np.std(gray))

    # Bright warm pixels ~ plume / burn
    warm = cv2.inRange(hsv, (0, 80, 160), (35, 255, 255))
    warm_frac = float(np.mean(warm > 0))

    # Very dark / flat → low value
    low_value = 1.0 if mean_v < 25 or std_gray < 12 else 0.0
    if mean_v < 40 and std_gray < 20:
        low_value = max(low_value, 0.7)

    # Edge density in upper band often = HUD / tickers
    edges = cv2.Canny(gray, 80, 160)
    top = edges[: edges.shape[0] // 4]
    bottom = edges[edges.shape[0] // 2 :]
    top_edge = float(np.mean(top > 0))
    bot_edge = float(np.mean(bottom > 0))
    hud_heavy = min(1.0, top_edge * 8.0) if top_edge > bot_edge * 1.4 else top_edge * 3.0

    plume_on = min(1.0, warm_frac * 12.0)
    landing_burn = min(1.0, warm_frac * 10.0) if warm_frac > 0.02 else 0.0

    # Mid brightness + structure, little warm → vehicle / pad guesses
    structure = min(1.0, std_gray / 60.0)
    vehicle_air = max(0.0, structure * 0.8 - plume_on * 0.5 - hud_heavy * 0.3)
    pad_or_tower = max(0.0, (1.0 - plume_on) * structure * 0.5)
    plume_off = max(0.0, structure * 0.4 - plume_on)

    scores = {
        "plume_on": round(plume_on, 4),
        "plume_off": round(plume_off, 4),
        "pad_or_tower": round(pad_or_tower, 4),
        "vehicle_air": round(vehicle_air, 4),
        "landing_burn": round(landing_burn, 4),
        "hud_heavy": round(min(1.0, hud_heavy), 4),
        "low_value": round(low_value, 4),
    }

    # Force low_value if dominant
    if scores["low_value"] >= 0.7:
        primary = "low_value"
    else:
        primary = max(
            (k for k in LABELS if k != "low_value"),
            key=lambda k: scores[k],
        )
        if scores[primary] < 0.15 and scores["hud_heavy"] >= 0.25:
            primary = "hud_heavy"

    rank = RANK_WEIGHT.get(primary, 0.0) * (0.5 + 0.5 * scores.get(primary, 0.0))
    if primary == "low_value":
        rank = 0.0

    return {
        "ok": True,
        "path": str(path),
        "primary": primary,
        "scores": scores,
        "rank": round(rank, 4),
        "features": {
            "mean_v": round(mean_v, 2),
            "std_gray": round(std_gray, 2),
            "warm_frac": round(warm_frac, 4),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("image", type=Path, help="Frame image path")
    args = ap.parse_args()
    out = _score(args.image)
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
