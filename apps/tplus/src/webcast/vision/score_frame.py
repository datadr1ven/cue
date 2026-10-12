#!/usr/bin/env python3
"""Baseline OpenCV scorer for TPlus webcast frame enrichment (v0 heuristics).

Not a trained model — fast, demoable, and replaceable by DNN later.
Prints JSON: primary label, scores, and an enrichment ``rank`` used to pick
the alert still. Rank favors readable plume + vehicle composition over
full-frame fireball blowouts (tuned against human picks.jsonl).
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

# Soft prior when breaking ties / footnotes — enrichment rank is separate
RANK_WEIGHT = {
    "landing_burn": 1.0,
    "plume_on": 0.95,
    "vehicle_air": 0.55,
    "plume_off": 0.45,
    "pad_or_tower": 0.4,
    "hud_heavy": 0.1,
    "low_value": 0.0,
}


def _sweet_warm(frac: float) -> float:
    """Peak around modest center warm — not a washed-out full-frame fireball."""
    if frac <= 0:
        return 0.0
    # Rise to 1.0 at ~0.28, hold to ~0.55, then decay hard past 0.75
    if frac < 0.28:
        return frac / 0.28
    if frac <= 0.55:
        return 1.0
    if frac <= 0.85:
        return max(0.0, 1.0 - (frac - 0.55) / 0.30)
    return max(0.0, 0.15 - (frac - 0.85))


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
    sat_mean = float(np.mean(hsv[:, :, 1]))

    # Bright warm pixels ~ plume / burn (strict + looser)
    warm = cv2.inRange(hsv, (0, 80, 160), (35, 255, 255))
    warm_loose = cv2.inRange(hsv, (0, 40, 120), (40, 255, 255))
    warm_frac = float(np.mean(warm > 0))
    warm_loose_frac = float(np.mean(warm_loose > 0))

    # Center crop — alert stills usually put action mid-frame
    cy, cx = small.shape[0] // 2, small.shape[1] // 2
    y0, y1 = max(0, cy - 50), min(small.shape[0], cy + 50)
    x0, x1 = max(0, cx - 70), min(small.shape[1], cx + 70)
    center = small[y0:y1, x0:x1]
    chsv = cv2.cvtColor(center, cv2.COLOR_BGR2HSV)
    warm_center = float(
        np.mean(cv2.inRange(chsv, (0, 40, 120), (40, 255, 255)) > 0)
    )

    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    sharp_n = min(1.0, sharp / 2200.0)

    # Very dark / flat → low value
    low_value = 1.0 if mean_v < 25 or std_gray < 12 else 0.0
    if mean_v < 40 and std_gray < 20:
        low_value = max(low_value, 0.7)
    # Extreme oversat fireball / posterized graphic
    if warm_loose_frac > 0.85 and sharp_n < 0.55:
        low_value = max(low_value, 0.55)

    # Edge density in upper band often = HUD / tickers
    edges = cv2.Canny(gray, 80, 160)
    top = edges[: edges.shape[0] // 4]
    bottom = edges[edges.shape[0] // 2 :]
    top_edge = float(np.mean(top > 0))
    bot_edge = float(np.mean(bottom > 0))
    hud_heavy = min(1.0, top_edge * 8.0) if top_edge > bot_edge * 1.4 else top_edge * 3.0

    sweet = _sweet_warm(warm_center)
    plume_on = min(1.0, max(warm_frac * 8.0, warm_center * 2.2) * (0.55 + 0.45 * sweet))
    # Landing burn: warm + lower-half bias
    lower = small[small.shape[0] // 2 :, :]
    lhsv = cv2.cvtColor(lower, cv2.COLOR_BGR2HSV)
    warm_lower = float(
        np.mean(cv2.inRange(lhsv, (0, 40, 120), (40, 255, 255)) > 0)
    )
    landing_burn = 0.0
    if warm_lower > 0.04:
        landing_burn = min(1.0, warm_lower * 2.5 * (0.4 + 0.6 * sweet) * (0.5 + 0.5 * sharp_n))

    structure = min(1.0, std_gray / 55.0)
    # Prefer readable mid-contrast over busy max-std (HUD chrome / clutter)
    # Human coast picks often sit ~25–50 std; model used to chase 70–90.
    structure_sweet = float(
        max(0.0, 1.0 - abs(std_gray - 40.0) / 45.0)
    )
    # vehicle_air: structure without much plume — keep weak so it rarely wins rank
    vehicle_air = max(
        0.0,
        structure_sweet * 0.55 * (1.0 - min(1.0, warm_center * 3.0)) - hud_heavy * 0.35,
    )
    pad_or_tower = max(0.0, (1.0 - plume_on) * structure_sweet * 0.45)
    plume_off = max(0.0, structure_sweet * 0.35 - plume_on * 0.8)

    scores = {
        "plume_on": round(min(1.0, plume_on), 4),
        "plume_off": round(plume_off, 4),
        "pad_or_tower": round(pad_or_tower, 4),
        "vehicle_air": round(vehicle_air, 4),
        "landing_burn": round(landing_burn, 4),
        "hud_heavy": round(min(1.0, hud_heavy), 4),
        "low_value": round(low_value, 4),
    }

    if scores["low_value"] >= 0.7:
        primary = "low_value"
    else:
        primary = max(
            (k for k in LABELS if k != "low_value"),
            key=lambda k: scores[k],
        )
        if scores[primary] < 0.15 and scores["hud_heavy"] >= 0.25:
            primary = "hud_heavy"

    # Enrichment rank = "would this make a good alert still?"
    # Prefer: sweet-spot plume, sharpness, some structure; penalize HUD / junk / blowouts.
    label_prior = RANK_WEIGHT.get(primary, 0.3)
    rank = (
        0.34 * sweet
        + 0.22 * sharp_n
        + 0.14 * min(1.0, structure)
        + 0.12 * label_prior
        + 0.10 * min(1.0, scores["landing_burn"])
        + 0.08 * min(1.0, scores["plume_on"])
        - 0.28 * scores["hud_heavy"]
        - 0.55 * scores["low_value"]
    )
    # Mild penalty for extreme global warm (blowout) even if center looked ok
    if warm_loose_frac > 0.75:
        rank -= 0.25 * (warm_loose_frac - 0.75) / 0.25
    rank = float(max(0.0, min(1.0, rank)))
    if primary == "low_value":
        rank = min(rank, 0.05)

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
            "warm_center": round(warm_center, 4),
            "warm_loose_frac": round(warm_loose_frac, 4),
            "sharp": round(sharp, 1),
            "sweet_warm": round(sweet, 4),
            "sat_mean": round(sat_mean, 1),
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
