#!/usr/bin/env python3
"""Per-milestone 'best still' picker for TPlus vision gold.

Opens a local HTML gallery: one section per actionId, click the frame that
should appear on the alert. Downloads picks.jsonl (product-shaped gold).

  python pick_best.py --run-dir ~/cue/tplus-webcast/runs/<id>
  # open vision/pick_best.html — click winners — Download picks.jsonl
  # save as runs/<id>/vision/picks.jsonl

This is the gold that matches the product: not scene taxonomy, but
"which frame should we show for liftoff / SECO / …".
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

_VIS = Path(__file__).resolve().parent
if str(_VIS) not in sys.path:
    sys.path.insert(0, str(_VIS))

from score_frame import _score  # noqa: E402

ACTION_RE = re.compile(r"^([a-zA-Z0-9._-]+)_(\d+)\.(jpg|jpeg|png|webp)$", re.I)


def _frames_by_action(frames_dir: Path) -> dict[str, list[Path]]:
    by: dict[str, list[Path]] = defaultdict(list)
    for p in sorted(frames_dir.iterdir()):
        if p.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        m = ACTION_RE.match(p.name)
        if not m:
            continue
        by[m.group(1)].append(p)
    return by


def _write_html(run_id: str, by_action: dict[str, list[Path]], scored: dict[str, dict]) -> str:
    sections = []
    for action in sorted(by_action):
        cards = []
        for p in by_action[action]:
            s = scored.get(p.name, {})
            primary = html.escape(str(s.get("primary") or ""))
            rank = s.get("rank")
            rank_s = "" if rank is None else f"rank={rank}"
            cards.append(
                f"""
<article class="card" data-action="{html.escape(action)}" data-frame="frames/{html.escape(p.name)}" data-primary="{primary}">
  <img src="frames/{html.escape(p.name)}" alt="{html.escape(p.name)}" loading="lazy"/>
  <div class="meta">
    <div class="file muted">{html.escape(p.name)}</div>
    <div class="muted">auto {primary} <span>{html.escape(rank_s)}</span></div>
    <button type="button" class="pick">Pick as best</button>
  </div>
</article>"""
            )
        sections.append(
            f"""
<section class="action" data-action="{html.escape(action)}">
  <h2>{html.escape(action)} <span class="choice muted" id="choice-{html.escape(action)}">— none picked —</span></h2>
  <div class="grid">{"".join(cards)}</div>
</section>"""
        )

    actions = json.dumps(sorted(by_action.keys()))
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Pick best stills — {html.escape(run_id)}</title>
<style>
  :root {{ font-family: system-ui, sans-serif; color: #e8eaed; background: #12141a; }}
  body {{ margin: 0; padding: 1rem 1.25rem 3rem; }}
  h1 {{ font-size: 1.2rem; margin: 0 0 .25rem; }}
  h2 {{ font-size: 1rem; margin: 1.5rem 0 .6rem; border-bottom: 1px solid #2a2f3a; padding-bottom: .35rem; }}
  .sub,.muted {{ color: #9aa0a6; }}
  .toolbar {{ position: sticky; top: 0; z-index: 2; background: #12141acc; backdrop-filter: blur(6px);
    padding: .6rem 0; display: flex; gap: .75rem; flex-wrap: wrap; align-items: center;
    border-bottom: 1px solid #2a2f3a; }}
  button {{ background: #2b3240; color: #e8eaed; border: 1px solid #3c4454; border-radius: 6px;
    padding: .35rem .7rem; cursor: pointer; font: inherit; }}
  button:hover {{ background: #3a4254; }}
  button.pick {{ font-size: .75rem; }}
  .card.winner {{ outline: 2px solid #7aa2ff; border-color: #7aa2ff; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .75rem; }}
  .card {{ background: #1a1e27; border: 1px solid #2a2f3a; border-radius: 10px; overflow: hidden; }}
  .card img {{ width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #000; display: block; }}
  .meta {{ padding: .5rem .65rem .7rem; font-size: .8rem; }}
  .file {{ font-size: .7rem; word-break: break-all; margin-bottom: .25rem; }}
  .choice {{ font-weight: 500; color: #9ecbff; }}
</style>
</head>
<body>
<h1>Pick best still — {html.escape(run_id)}</h1>
<p class="sub">For each milestone, click <b>Pick as best</b> on the frame that should go on the Telegram / Pages alert.
Ignore scene taxonomy — just “what would I want to show?”</p>
<div class="toolbar">
  <button type="button" id="dl">Download picks.jsonl</button>
  <span class="muted" id="stat"></span>
</div>
{"".join(sections)}
<script>
const actions = {actions};
const picks = {{}};
function sync() {{
  const n = Object.keys(picks).length;
  document.getElementById('stat').textContent = n + ' / ' + actions.length + ' milestones picked';
}}
document.querySelectorAll('.card .pick').forEach(btn => {{
  btn.addEventListener('click', () => {{
    const card = btn.closest('.card');
    const action = card.dataset.action;
    const frame = card.dataset.frame;
    document.querySelectorAll('.card[data-action="'+action+'"]').forEach(c => c.classList.remove('winner'));
    card.classList.add('winner');
    picks[action] = {{
      runId: {json.dumps(run_id)},
      actionId: action,
      frame: 'vision/' + frame,
      notes: 'human-best-still'
    }};
    document.getElementById('choice-'+action).textContent = frame.replace(/^frames\\//,'');
    sync();
  }});
}});
document.getElementById('dl').onclick = () => {{
  const lines = actions.filter(a => picks[a]).map(a => JSON.stringify(picks[a]));
  const blob = new Blob(lines.map(l => l + '\\n'), {{type: 'application/x-ndjson'}});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'picks.jsonl';
  a.click();
  URL.revokeObjectURL(a.href);
}};
sync();
</script>
</body>
</html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument(
        "--max-per-action",
        type=int,
        default=24,
        help="Subsample evenly if a window has more frames (default 24)",
    )
    args = ap.parse_args()
    run_dir = args.run_dir.expanduser().resolve()
    frames_dir = run_dir / "vision" / "frames"
    if not frames_dir.is_dir():
        print(f"No vision/frames under {run_dir}", file=sys.stderr)
        return 1

    by = _frames_by_action(frames_dir)
    # subsample for clickable UI
    for act, files in list(by.items()):
        if len(files) <= args.max_per_action:
            continue
        k = args.max_per_action
        idxs = sorted({int(round(i * (len(files) - 1) / (k - 1))) for i in range(k)})
        by[act] = [files[i] for i in idxs]

    scored: dict[str, dict] = {}
    for files in by.values():
        for p in files:
            s = _score(p)
            if s.get("ok"):
                scored[p.name] = s

    out = run_dir / "vision" / "pick_best.html"
    out.write_text(_write_html(run_dir.name, by, scored), encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "runId": run_dir.name,
                "actions": {a: len(fs) for a, fs in by.items()},
                "html": str(out),
            },
            indent=2,
        )
    )
    print(
        f"\nOpen {out} (serve the vision/ dir), pick winners, save picks.jsonl next to it.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
