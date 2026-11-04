#!/usr/bin/env python3
"""Keep the public TPlus Pages feed visually pretty.

1. Score each still with OpenCV 5; strip imageUrl when the frame is black,
   HUD-heavy, or pad-only for an in-flight milestone.
2. By default, **drop items with no imageUrl** so the Pages wall is not a
   run of text-only bubbles (Telegram delivery is unchanged — this only
   edits the public KV feed).

Designed for daily cron via scripts/feed-cleanup.sh.

  python feed_cleanup.py --feed feed.json --out feed-clean.json
  python feed_cleanup.py --feed-url https://tplus…/recent?limit=50 --out …
  python feed_cleanup.py … --keep-text-only   # only strip bad images
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_VIS = Path(__file__).resolve().parent
if str(_VIS) not in sys.path:
    sys.path.insert(0, str(_VIS))

from score_frame import _score  # noqa: E402

# In-flight / non-pad events: pad_or_tower almost never "shows" the milestone.
_PAD_NEVER_OK = frozenset(
    {
        "max_q",
        "supersonic",
        "meco",
        "stage_sep",
        "side_sep",
        "ses",
        "ses1",
        "ses2",
        "fairing",
        "entry_burn",
        "entry_burn_end",
        "boostback_start",
        "boostback_end",
        "landing_burn_booster",
        "booster_landing",
        "seco",
        "seco2",
        "dragon_separation",
        "dragon_nosecode_open",
        "kick_stage_separation",
        "kick_stage_ignition",
        "kick_stage_cut_off",
        "battery_hotswap",
        "deploy_start",
        "stage_1_flip",
    }
)


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "TPlusFeedCleanup/1.0",
            "Referer": "https://t-plus.pages.dev/",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download(url: str, dest: Path) -> bool:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; TPlusFeedCleanup/1.0)",
            "Referer": "https://t-plus.pages.dev/",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            dest.write_bytes(resp.read())
        return dest.stat().st_size > 100
    except Exception as e:
        print(f"  download fail: {e}", file=sys.stderr)
        return False


def decide_strip(action_id: str | None, primary: str | None, rank: float) -> str | None:
    """Return reason string if imageUrl should be stripped, else None."""
    aid = (action_id or "").strip()
    prim = (primary or "").strip()

    if prim in ("hud_heavy", "low_value"):
        return f"primary={prim}"
    if prim == "pad_or_tower" and aid in _PAD_NEVER_OK:
        return f"pad_or_tower for in-flight action {aid}"
    # Very weak ranks with no useful structure — refuse
    if rank < 0.12 and prim not in ("plume_on", "landing_burn"):
        return f"rank={rank:.3f} primary={prim}"
    return None


def cleanup_feed(
    feed: dict,
    *,
    work_dir: Path,
    dry_run: bool = False,
    drop_text_only: bool = True,
) -> tuple[dict, list[dict]]:
    items = list(feed.get("items") or [])
    actions: list[dict] = []
    new_items: list[dict] = []

    for i, it in enumerate(items):
        url = it.get("imageUrl")
        if not url or not str(url).startswith("https://"):
            if drop_text_only:
                actions.append(
                    {
                        "id": it.get("id"),
                        "actionId": it.get("actionId"),
                        "missionName": it.get("missionName"),
                        "reason": "no_image",
                        "drop": True,
                    }
                )
                if dry_run:
                    new_items.append(it)
                # else: omit from feed
            else:
                new_items.append(it)
            continue

        mid = str(url).rstrip("/").split("/")[-1]
        dest = work_dir / f"{i:02d}_{it.get('actionId') or 'x'}_{mid}.jpg"
        if not _download(str(url), dest):
            # Unreachable media → strip so the page does not show broken imgs
            reason = "download_failed"
            actions.append(
                {
                    "id": it.get("id"),
                    "actionId": it.get("actionId"),
                    "missionName": it.get("missionName"),
                    "reason": reason,
                }
            )
            if dry_run:
                new_items.append(it)
            elif drop_text_only:
                actions[-1]["drop"] = True
                # omit item
            else:
                cleaned = dict(it)
                cleaned.pop("imageUrl", None)
                new_items.append(cleaned)
            continue

        scored = _score(dest)
        primary = scored.get("primary")
        rank = float(scored.get("rank") or 0)
        reason = decide_strip(it.get("actionId"), primary, rank)
        if reason:
            actions.append(
                {
                    "id": it.get("id"),
                    "actionId": it.get("actionId"),
                    "missionName": it.get("missionName"),
                    "reason": reason,
                    "primary": primary,
                    "rank": round(rank, 3),
                    "drop": bool(drop_text_only),
                }
            )
            if dry_run:
                new_items.append(it)
            elif drop_text_only:
                pass  # omit item entirely from public feed
            else:
                cleaned = dict(it)
                cleaned.pop("imageUrl", None)
                new_items.append(cleaned)
        else:
            new_items.append(it)

    out = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
        + "Z",
        "items": new_items,
    }
    # Preserve any extra top-level keys except canary noise
    for k, v in feed.items():
        if k not in ("updatedAt", "items", "canary"):
            out[k] = v
    return out, actions


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--feed", type=Path, help="Local feed JSON (KV export)")
    ap.add_argument(
        "--feed-url",
        default="",
        help="Fetch feed from URL (e.g. Worker /recent?limit=50)",
    )
    ap.add_argument("--out", type=Path, required=True, help="Write cleaned feed JSON")
    ap.add_argument(
        "--report",
        type=Path,
        help="Write JSONL of strip actions",
    )
    ap.add_argument("--dry-run", action="store_true", help="Score only; do not modify feed")
    ap.add_argument(
        "--keep-text-only",
        action="store_true",
        help="Only strip bad imageUrls; keep text-only alerts on the Pages feed",
    )
    ap.add_argument(
        "--work-dir",
        type=Path,
        help="Directory for downloaded stills (default: temp)",
    )
    args = ap.parse_args()

    if args.feed:
        feed = json.loads(args.feed.read_text())
    elif args.feed_url:
        feed = _fetch_json(args.feed_url)
        # /recent wraps items; KV is bare {updatedAt,items}
        if "product" in feed and "items" in feed:
            feed = {"updatedAt": feed.get("updatedAt"), "items": feed["items"]}
    else:
        print("Need --feed or --feed-url", file=sys.stderr)
        return 2

    work = args.work_dir or Path(tempfile.mkdtemp(prefix="tplus-feed-clean-"))
    work.mkdir(parents=True, exist_ok=True)

    drop_text_only = not args.keep_text_only
    cleaned, actions = cleanup_feed(
        feed,
        work_dir=work,
        dry_run=args.dry_run,
        drop_text_only=drop_text_only,
    )
    args.out.write_text(json.dumps(cleaned, ensure_ascii=False))
    if args.report:
        args.report.write_text(
            "\n".join(json.dumps(a, ensure_ascii=False) for a in actions)
            + ("\n" if actions else "")
        )

    before_items = len(feed.get("items") or [])
    before_imgs = sum(1 for i in (feed.get("items") or []) if i.get("imageUrl"))
    after_items = len(cleaned["items"])
    after_imgs = sum(1 for i in cleaned["items"] if i.get("imageUrl"))
    dropped = sum(1 for a in actions if a.get("drop"))
    mode = "dry-run" if args.dry_run else "apply"
    print(
        json.dumps(
            {
                "ok": True,
                "mode": mode,
                "dropTextOnly": drop_text_only,
                "itemsBefore": before_items,
                "itemsAfter": after_items if not args.dry_run else before_items,
                "imagesBefore": before_imgs,
                "imagesAfter": after_imgs if not args.dry_run else before_imgs,
                "wouldChange": len(actions),
                "changed": 0 if args.dry_run else len(actions),
                "wouldDropItems": dropped,
                "droppedItems": 0 if args.dry_run else dropped,
                "actions": actions,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
