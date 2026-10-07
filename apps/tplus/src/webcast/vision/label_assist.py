#!/usr/bin/env python3
"""Build a stratified labeling pack from dense vision frames.

Writes under each run (and optionally a combined gold dir):

  vision/labels.auto.jsonl   # auto-scored stubs (schema-compatible)
  vision/review.html         # local gallery to correct → labels.jsonl

Also writes a combined index + JSONL when --gold-dir is set.

Examples:
  python label_assist.py --runs-root ~/cue/tplus-webcast/runs --per-window 6
  python label_assist.py --run-dir …/flight-14 --per-window 8 --gold-dir ~/cue/tplus-webcast/vision-gold
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

_VIS = Path(__file__).resolve().parent
if str(_VIS) not in sys.path:
    sys.path.insert(0, str(_VIS))

from score_frame import LABELS, _score  # noqa: E402

ACTION_RE = re.compile(r"^([a-zA-Z0-9._-]+)_(\d+)\.(jpg|jpeg|png|webp)$", re.I)


def _parse_frame_name(name: str) -> tuple[str | None, int | None]:
    m = ACTION_RE.match(name)
    if not m:
        return None, None
    return m.group(1), int(m.group(2))


def _approx_t_plus(
    manifest: dict | None, action: str | None, frame_idx: int | None, fps: float
) -> float | None:
    if not manifest or not action or frame_idx is None:
        return None
    for w in manifest.get("windows") or []:
        if w.get("actionId") != action:
            continue
        # frame N ≈ start + (N-1)/fps; center = liftoffVideoSec + clockTPlus
        # relative to mission: clock at start ≈ clockTPlus - before
        clock = w.get("clockTPlusSec")
        start = w.get("startSec")
        center = w.get("centerSec")
        if clock is None or start is None or center is None:
            return None
        t_video = float(start) + max(0, frame_idx - 1) / max(fps, 0.01)
        return round(float(clock) + (t_video - float(center)), 2)
    return None


def _load_manifest(run_dir: Path) -> dict | None:
    p = run_dir / "vision" / "manifest.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _stratified_pick(files: list[Path], per_window: int) -> list[Path]:
    """Evenly sample per actionId prefix; always include first/mid/last when possible."""
    by_action: dict[str, list[Path]] = defaultdict(list)
    other: list[Path] = []
    for p in sorted(files):
        action, _ = _parse_frame_name(p.name)
        if action:
            by_action[action].append(p)
        else:
            other.append(p)

    picked: list[Path] = []
    for action in sorted(by_action):
        group = by_action[action]
        n = len(group)
        if n == 0:
            continue
        k = min(per_window, n)
        if k == 1:
            idxs = [n // 2]
        else:
            # inclusive endpoints
            idxs = sorted({int(round(i * (n - 1) / (k - 1))) for i in range(k)})
        picked.extend(group[i] for i in idxs)

    if other and per_window > 0:
        k = min(per_window, len(other))
        step = max(1, len(other) // k)
        picked.extend(other[::step][:k])
    return picked


def _record(
    run_id: str,
    run_dir: Path,
    path: Path,
    scored: dict,
    manifest: dict | None,
) -> dict:
    rel = str(path.relative_to(run_dir))
    action, idx = _parse_frame_name(path.name)
    fps = float((manifest or {}).get("fps") or 2.0)
    t_plus = _approx_t_plus(manifest, action, idx, fps)
    primary = scored.get("primary") or "low_value"
    return {
        "runId": run_id,
        "frame": rel,
        "tPlusSec": t_plus,
        "nearActionId": action,
        "labels": [primary],
        "primary": primary,
        "notes": "auto:score_frame_v0 — correct in review.html",
        "auto": {
            "primary": primary,
            "rank": scored.get("rank"),
            "scores": scored.get("scores"),
            "features": scored.get("features"),
        },
    }


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            # Strip auto blob for schema-ish gold file? Keep in .auto; gold drops it later.
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _review_html(run_id: str, rows: list[dict], labels: tuple[str, ...]) -> str:
    label_btns = "".join(
        f'<button type="button" class="lab" data-lab="{html.escape(l)}">{html.escape(l)}</button>'
        for l in labels
    )
    cards = []
    for i, row in enumerate(rows):
        src = html.escape(Path(row["frame"]).name)
        # review.html lives in vision/ → frames are ./frames/<file>
        frame_rel = html.escape("frames/" + Path(row["frame"]).name)
        primary = html.escape(str(row.get("primary") or ""))
        action = html.escape(str(row.get("nearActionId") or ""))
        tplus = row.get("tPlusSec")
        tplus_s = "" if tplus is None else f"T+{tplus}s"
        rank = (row.get("auto") or {}).get("rank")
        rank_s = "" if rank is None else f"rank={rank}"
        cards.append(
            f"""
<article class="card" data-idx="{i}" data-primary="{primary}">
  <img src="{frame_rel}" alt="{src}" loading="lazy"/>
  <div class="meta">
    <div><b>{action}</b> {html.escape(tplus_s)} <span class="muted">{html.escape(rank_s)}</span></div>
    <div class="file muted">{html.escape(row['frame'])}</div>
    <div class="current">primary: <code class="cur">{primary}</code></div>
    <div class="labs">{label_btns}</div>
  </div>
</article>"""
        )

    # Raw JSON in <script type="application/json"> — do NOT html.escape
    # (that turns " into &quot; and JSON.parse throws → dead click handlers).
    # Only neutralize literal </script> so the HTML parser cannot close early.
    payload = (
        json.dumps(rows, ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )
    cards_html = "\n".join(cards)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>TPlus vision label review — {html.escape(run_id)}</title>
<style>
  :root {{ font-family: ui-sans-serif, system-ui, sans-serif; color: #e8eaed; background: #12141a; }}
  body {{ margin: 0; padding: 1rem 1.25rem 3rem; }}
  h1 {{ font-size: 1.15rem; font-weight: 600; margin: 0 0 .25rem; }}
  .sub {{ color: #9aa0a6; font-size: .9rem; margin-bottom: 1rem; }}
  .toolbar {{ position: sticky; top: 0; z-index: 2; background: #12141acc; backdrop-filter: blur(6px);
    padding: .6rem 0; display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; border-bottom: 1px solid #2a2f3a; }}
  button, .btn {{ background: #2b3240; color: #e8eaed; border: 1px solid #3c4454; border-radius: 6px;
    padding: .35rem .7rem; cursor: pointer; font: inherit; }}
  button:hover, .btn:hover {{ background: #3a4254; }}
  button.lab.active {{ outline: 2px solid #7aa2ff; background: #243056; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; margin-top: 1rem; }}
  .card {{ background: #1a1e27; border: 1px solid #2a2f3a; border-radius: 10px; overflow: hidden; }}
  .card.done {{ border-color: #3d7a57; }}
  .card img {{ width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #000; display: block; }}
  .meta {{ padding: .65rem .75rem .85rem; font-size: .85rem; }}
  .muted {{ color: #9aa0a6; }}
  .file {{ font-size: .75rem; word-break: break-all; margin: .2rem 0 .4rem; }}
  .labs {{ display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .45rem; }}
  .labs .lab {{ font-size: .72rem; padding: .2rem .4rem; }}
  code.cur {{ color: #9ecbff; }}
  .stat {{ color: #bdc1c6; }}
</style>
</head>
<body>
<h1>Label review — {html.escape(run_id)}</h1>
<p class="sub">Click a label to set <code>primary</code>. Mark corrected cards, then download JSONL.
Auto suggestions are from <code>score_frame</code> heuristics — fix freely.</p>
<div class="toolbar">
  <button type="button" id="dl">Download labels.jsonl</button>
  <button type="button" id="dlauto">Download labels.auto.jsonl (unchanged)</button>
  <span class="stat" id="stat"></span>
</div>
<div class="grid" id="grid">
{cards_html}
</div>
<script id="data" type="application/json">{payload}</script>
<script>
const labels = {json.dumps(list(labels))};
let rows;
try {{
  rows = JSON.parse(document.getElementById('data').textContent);
}} catch (err) {{
  document.getElementById('stat').textContent = 'ERROR: label data failed to parse — ' + err;
  throw err;
}}
const cards = [...document.querySelectorAll('.card')];

function syncStat() {{
  const changed = rows.filter((r, i) => r.primary !== (r.auto && r.auto.primary)).length;
  document.getElementById('stat').textContent =
    rows.length + ' frames · ' + changed + ' edited from auto';
}}

function setPrimary(idx, lab) {{
  rows[idx].primary = lab;
  rows[idx].labels = [lab];
  if (rows[idx].notes && rows[idx].notes.startsWith('auto:')) {{
    rows[idx].notes = 'human-corrected';
  }}
  const card = cards[idx];
  card.dataset.primary = lab;
  card.querySelector('.cur').textContent = lab;
  card.classList.add('done');
  card.querySelectorAll('.lab').forEach(b => b.classList.toggle('active', b.dataset.lab === lab));
  syncStat();
}}

cards.forEach(card => {{
  const idx = +card.dataset.idx;
  const cur = rows[idx].primary;
  card.querySelectorAll('.lab').forEach(b => {{
    if (b.dataset.lab === cur) b.classList.add('active');
    b.addEventListener('click', () => setPrimary(idx, b.dataset.lab));
  }});
}});

function download(name) {{
  const out = rows.map(r => {{
    const o = {{
      runId: r.runId,
      frame: r.frame,
      tPlusSec: r.tPlusSec,
      nearActionId: r.nearActionId,
      labels: r.labels,
      primary: r.primary,
    }};
    if (r.notes) o.notes = r.notes;
    return o;
  }});
  const blob = new Blob(out.map(o => JSON.stringify(o) + '\\n'), {{type: 'application/x-ndjson'}});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}}
document.getElementById('dl').onclick = () => download('labels.jsonl');
document.getElementById('dlauto').onclick = () => download('labels.auto.jsonl');
syncStat();
</script>
</body>
</html>
"""


def _discover_runs(runs_root: Path | None, run_dirs: list[Path]) -> list[Path]:
    found: list[Path] = []
    if runs_root:
        for d in sorted(runs_root.iterdir()):
            if d.is_dir() and (d / "vision" / "frames").is_dir():
                found.append(d)
    for d in run_dirs:
        d = d.expanduser().resolve()
        if d.is_dir() and d not in found:
            found.append(d)
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runs-root", type=Path, help="tplus-webcast/runs directory")
    ap.add_argument("--run-dir", type=Path, action="append", default=[], help="Repeatable")
    ap.add_argument(
        "--per-window",
        type=int,
        default=6,
        help="Frames to sample per action window (default 6 → ~168 across 4×7)",
    )
    ap.add_argument(
        "--gold-dir",
        type=Path,
        default=None,
        help="Optional combined output dir (index.html + labels.auto.jsonl)",
    )
    ap.add_argument(
        "--all-frames",
        action="store_true",
        help="Score every frame (no stratified subsample)",
    )
    args = ap.parse_args()

    runs = _discover_runs(
        args.runs_root.expanduser().resolve() if args.runs_root else None,
        args.run_dir,
    )
    if not runs:
        print("No runs with vision/frames found. Pass --runs-root or --run-dir.", file=sys.stderr)
        return 1

    all_rows: list[dict] = []

    for run_dir in runs:
        run_id = run_dir.name
        frames_dir = run_dir / "vision" / "frames"
        files = sorted(
            p
            for p in frames_dir.iterdir()
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        )
        if not files:
            continue
        sample = files if args.all_frames else _stratified_pick(files, args.per_window)
        manifest = _load_manifest(run_dir)
        rows: list[dict] = []
        for p in sample:
            scored = _score(p)
            if not scored.get("ok"):
                continue
            rows.append(_record(run_id, run_dir, p, scored, manifest))

        auto_path = run_dir / "vision" / "labels.auto.jsonl"
        _write_jsonl(auto_path, rows)
        review_path = run_dir / "vision" / "review.html"
        review_path.write_text(_review_html(run_id, rows, LABELS), encoding="utf-8")
        all_rows.extend(rows)
        print(f"[label_assist] {run_id}: {len(rows)} stubs → {auto_path}", flush=True)

    if args.gold_dir:
        gold = args.gold_dir.expanduser().resolve()
        gold.mkdir(parents=True, exist_ok=True)
        combined = gold / "labels.auto.jsonl"
        _write_jsonl(combined, all_rows)
        rel_links = []
        for run_dir in runs:
            review = (run_dir / "vision" / "review.html").resolve()
            # Relative to gold index (handles sibling ../runs/...)
            try:
                href = str(review.relative_to(gold))
            except ValueError:
                href = os.path.relpath(str(review), str(gold))
            n = sum(1 for r in all_rows if r["runId"] == run_dir.name)
            rel_links.append(
                f'<li><a href="{html.escape(href)}">{html.escape(run_dir.name)}</a> — {n} frames</li>'
            )
        (gold / "index.html").write_text(
            f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>TPlus vision gold</title>
<style>body{{font-family:system-ui;background:#12141a;color:#e8eaed;padding:1.5rem}}
a{{color:#9ecbff}} li{{margin:.4rem 0}} .muted{{color:#9aa0a6}}</style></head>
<body>
<h1>TPlus vision gold — label review</h1>
<p>{len(all_rows)} auto-labeled stubs across {len(runs)} runs.
Open a run, correct labels, download <code>labels.jsonl</code>, save next to frames as
<code>vision/labels.jsonl</code>.</p>
<ul>
{chr(10).join(rel_links)}
</ul>
<p class="muted">Combined auto file: <code>labels.auto.jsonl</code></p>
</body></html>
""",
            encoding="utf-8",
        )
        print(f"[label_assist] gold index → {gold / 'index.html'} ({len(all_rows)} rows)", flush=True)

    print(
        json.dumps(
            {
                "ok": True,
                "runs": len(runs),
                "stubs": len(all_rows),
                "perWindow": args.per_window,
                "allFrames": args.all_frames,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
