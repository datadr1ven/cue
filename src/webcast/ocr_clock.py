#!/usr/bin/env python3
"""
Weak-signal mission clock OCR from SpaceX webcast frames.

Prototype for TPlus hybrid assist (ensemble with ASR + script gate).
Uses RapidOCR (pip) — no system tesseract required.

  .venv-webcast/bin/python src/webcast/ocr_clock.py \
    --video /tmp/roman-window.mp4 --every 30 --from 100 --to 700

  # Frame + OCR side-by-side in the browser:
  npm run webcast:ocr-clock -- --video /tmp/roman-window.mp4 --from 100 --to 400 --every 40 --show

Notes from Roman FH spike (/tmp/roman-window.mp4):
  - HUD clock moves (T− often bottom-center; T+ often top).
  - Full-frame OCR finds T± strings fairly often.
  - Absolute digits are frequently wrong; sign (T−/T+) and
    *deltas between samples* are more trustworthy weak signals.
  - Host/interview full-frames → no clock (expected miss).
"""

from __future__ import annotations

import argparse
import html
import re
import subprocess
import sys
import tempfile
import webbrowser
from pathlib import Path

# Lazy import heavy deps after argparse --help


CLOCK_RE = re.compile(
    r"T\s*([+\-−])\s*(\d{1,2}):(\d{2}):(\d{2})",
    re.IGNORECASE,
)
EVENT_HINTS = re.compile(
    r"\b(MAX\s*Q|MAXQ|MECO|BECO|STAGE\s*SEP|HOT\s*STAG|ENTRY\s*BURN|"
    r"LANDING\s*BURN|LIFTOFF|LIFT\s*OFF|FAIRING|SECO)\b",
    re.IGNORECASE,
)


def parse_clock_texts(texts: list[str]) -> tuple[int | None, str | None]:
    """Return (signed_seconds, raw_match) from OCR text lines."""
    joined = " ".join(texts)
    m = CLOCK_RE.search(joined)
    if not m:
        # T+ and HH:MM:SS sometimes arrive as adjacent boxes
        compact = re.sub(r"\s+", "", joined.upper())
        m2 = re.search(r"T([+\-−])(\d{1,2}):(\d{2}):(\d{2})", compact)
        if not m2:
            return None, None
        sign = -1 if m2.group(1) in "-−" else 1
        sec = int(m2.group(2)) * 3600 + int(m2.group(3)) * 60 + int(m2.group(4))
        return sign * sec, m2.group(0)
    sign = -1 if m.group(1) in "-−" else 1
    sec = int(m.group(2)) * 3600 + int(m.group(3)) * 60 + int(m.group(4))
    return sign * sec, m.group(0)


def format_signed(sec: int | None) -> str:
    if sec is None:
        return "—"
    sign = "-" if sec < 0 else "+"
    a = abs(sec)
    h, rem = divmod(a, 3600)
    m, s = divmod(rem, 60)
    return f"T{sign}{h:02d}:{m:02d}:{s:02d}"


def extract_frame(video: Path, t_sec: float, out: Path) -> bool:
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            str(t_sec),
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(out),
        ],
        capture_output=True,
    )
    return r.returncode == 0 and out.exists()


def ocr_frame(ocr, image_path: Path, scale: float = 1.5) -> list[str]:
    import cv2

    img = cv2.imread(str(image_path))
    if img is None:
        return []
    if scale and scale != 1.0:
        img = cv2.resize(
            img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC
        )
    result, _elapse = ocr(img)
    if not result:
        return []
    return [row[1] for row in result]


def write_html_report(
    out_path: Path,
    *,
    video_name: str,
    rows: list[dict],
    hits: int,
    samples: int,
) -> None:
    """Side-by-side frame + OCR result gallery."""
    cards = []
    for r in rows:
        img = r.get("img_rel") or ""
        clock = html.escape(r.get("clock") or "—")
        raw = html.escape(r.get("raw") or "")
        events = html.escape(r.get("events") or "—")
        texts = r.get("texts") or []
        text_list = (
            "<ul class='texts'>"
            + "".join(f"<li>{html.escape(t)}</li>" for t in texts[:40])
            + ("<li>…</li>" if len(texts) > 40 else "")
            + "</ul>"
            if texts
            else "<p class='muted'>no OCR text</p>"
        )
        miss = " miss" if r.get("clock_sec") is None else ""
        cards.append(
            f"""
<article class='card{miss}'>
  <div class='meta'>
    <div class='t'>file t={r['file_t']:.0f}s</div>
    <div class='clock'>{clock}</div>
    <div class='deltas'>Δfile {html.escape(r.get('d_file') or '—')} · Δocr {html.escape(r.get('d_ocr') or '—')}</div>
    <div class='events'>events: {events}</div>
    <div class='raw'>match: {raw or '—'}</div>
    {text_list}
  </div>
  <a class='frame' href='{html.escape(img)}' target='_blank' rel='noopener'>
    <img src='{html.escape(img)}' alt='frame at {r["file_t"]:.0f}s' loading='lazy'/>
  </a>
</article>"""
        )

    pct = (100 * hits / samples) if samples else 0
    doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>webcast ocr-clock — {html.escape(video_name)}</title>
<style>
  :root {{ color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }}
  body {{ margin: 0; background: #0f1115; color: #e8eaed; }}
  header {{ padding: 1rem 1.25rem; border-bottom: 1px solid #2a2f3a; position: sticky; top: 0; background: #0f1115cc; backdrop-filter: blur(8px); }}
  header h1 {{ margin: 0 0 .25rem; font-size: 1.1rem; font-weight: 600; }}
  header p {{ margin: 0; color: #9aa0a6; font-size: .9rem; }}
  main {{ display: flex; flex-direction: column; gap: 1rem; padding: 1rem 1.25rem 3rem; }}
  .card {{ display: grid; grid-template-columns: minmax(220px, 340px) 1fr; gap: 1rem; background: #1a1d24; border: 1px solid #2a2f3a; border-radius: 10px; padding: .75rem; }}
  .card.miss {{ border-color: #5c3d1e; }}
  .meta {{ font-size: .9rem; line-height: 1.35; }}
  .clock {{ font-size: 1.4rem; font-weight: 700; font-variant-numeric: tabular-nums; margin: .35rem 0; }}
  .muted, .deltas, .events, .raw {{ color: #9aa0a6; }}
  .texts {{ margin: .5rem 0 0; padding-left: 1.1rem; max-height: 12rem; overflow: auto; color: #c4c7ce; }}
  .frame {{ display: block; }}
  .frame img {{ width: 100%; height: auto; border-radius: 6px; background: #000; }}
  @media (max-width: 800px) {{ .card {{ grid-template-columns: 1fr; }} }}
</style>
</head>
<body>
<header>
  <h1>webcast ocr-clock · {html.escape(video_name)}</h1>
  <p>{samples} samples · {hits} clock hits ({pct:.0f}%) · click frame for full size</p>
</header>
<main>
{"".join(cards)}
</main>
</body>
</html>
"""
    out_path.write_text(doc, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Webcast mission-clock OCR prototype")
    ap.add_argument("--video", required=True, help="Path to mp4/mkv")
    ap.add_argument("--every", type=float, default=30.0, help="Sample period (sec)")
    ap.add_argument("--from", dest="from_sec", type=float, default=0.0)
    ap.add_argument("--to", dest="to_sec", type=float, default=None)
    ap.add_argument("--scale", type=float, default=1.5, help="Upscale before OCR")
    ap.add_argument(
        "--keep-frames",
        action="store_true",
        help="Keep extracted JPEGs under /tmp/cue-webcast-ocr/",
    )
    ap.add_argument(
        "--html",
        nargs="?",
        const="AUTO",
        default=None,
        help="Write HTML gallery (frame | OCR). Default path under /tmp/cue-webcast-ocr/",
    )
    ap.add_argument(
        "--show",
        action="store_true",
        help="Write HTML gallery and open it in the browser (implies keep-frames)",
    )
    ap.add_argument(
        "--no-open",
        action="store_true",
        help="With --show, write HTML but do not open the browser",
    )
    ap.add_argument(
        "--lock",
        action="store_true",
        help="Emit JSON clock lock to stdout (liftoff file offset from OCR samples). "
        "Human table goes to stderr.",
    )
    args = ap.parse_args()

    video = Path(args.video).expanduser().resolve()
    if not video.exists():
        print(f"video not found: {video}", file=sys.stderr)
        return 1

    want_html = args.show or args.html is not None
    keep_frames = args.keep_frames or want_html

    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()

    # duration via ffprobe
    to_sec = args.to_sec
    if to_sec is None:
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nk=1:nw=1",
                str(video),
            ],
            capture_output=True,
            text=True,
        )
        to_sec = float(probe.stdout.strip() or 0)

    keep_dir = Path("/tmp/cue-webcast-ocr")
    if keep_frames:
        keep_dir.mkdir(parents=True, exist_ok=True)

    html_path = None
    if want_html:
        if args.html and args.html != "AUTO":
            html_path = Path(args.html).expanduser().resolve()
        else:
            html_path = keep_dir / f"{video.stem}-ocr-report.html"

    def log(msg: str = "") -> None:
        # Keep stdout clean for --lock JSON
        print(msg, file=sys.stderr if args.lock else sys.stdout, flush=True)

    log(f"video={video.name} sample={args.from_sec:.0f}→{to_sec:.0f}s every={args.every}s")
    log(f"{'file_t':>8}  {'ocr_clock':12}  {'Δfile':>6}  {'Δocr':>6}  events")

    prev_file = None
    prev_ocr = None
    hits = 0
    samples = 0
    report_rows: list[dict] = []
    lock_samples: list[dict] = []

    t = args.from_sec
    with tempfile.TemporaryDirectory(prefix="cue-ocr-") as tmp:
        tmp_path = Path(tmp)
        while t <= to_sec + 1e-6:
            samples += 1
            frame = tmp_path / f"f_{int(t)}.jpg"
            if not extract_frame(video, t, frame):
                log(f"{t:8.0f}  (ffmpeg miss)")
                t += args.every
                continue

            img_rel = None
            if keep_frames:
                dest = keep_dir / f"{video.stem}_{int(t)}.jpg"
                dest.write_bytes(frame.read_bytes())
                img_rel = dest.name  # report sits in keep_dir

            texts = ocr_frame(ocr, frame, scale=args.scale)
            clock_sec, raw = parse_clock_texts(texts)
            events = sorted(
                {m.group(0).upper() for m in EVENT_HINTS.finditer(" ".join(texts))}
            )

            d_file = "" if prev_file is None else f"{t - prev_file:+.0f}"
            d_ocr = ""
            if clock_sec is not None and prev_ocr is not None:
                d_ocr = f"{clock_sec - prev_ocr:+d}"
            if clock_sec is not None:
                hits += 1
                prev_ocr = clock_sec
                # mission_tplus = file_t - liftoff_file  ⇒  liftoff_file = file_t - clock_sec
                lock_samples.append(
                    {
                        "fileSec": t,
                        "clockSec": clock_sec,
                        "liftoffFileSec": t - clock_sec,
                        "raw": raw,
                    }
                )
            prev_file = t

            log(
                f"{t:8.0f}  {format_signed(clock_sec):12}  {d_file:>6}  {d_ocr:>6}  "
                f"{','.join(events) or '—'}  {raw or ''}"
            )

            if want_html:
                report_rows.append(
                    {
                        "file_t": t,
                        "clock": format_signed(clock_sec),
                        "clock_sec": clock_sec,
                        "d_file": d_file,
                        "d_ocr": d_ocr,
                        "events": ",".join(events) or "—",
                        "raw": raw or "",
                        "texts": texts,
                        "img_rel": img_rel or "",
                    }
                )
            t += args.every

    log(
        f"Done · samples={samples} clock_hits={hits} "
        f"({(100 * hits / samples) if samples else 0:.0f}%)"
    )
    log(
        "Tip: trust T−/T+ sign + Δocr≈Δfile more than absolute digits; "
        "pair with ASR/script gate."
    )

    if want_html and html_path is not None:
        write_html_report(
            html_path,
            video_name=video.name,
            rows=report_rows,
            hits=hits,
            samples=samples,
        )
        log(f"HTML report: {html_path}")
        log(f"Frames dir:  {keep_dir}")
        if args.show and not args.no_open:
            webbrowser.open(html_path.as_uri())

    if args.lock:
        import json
        from statistics import median

        if len(lock_samples) < 1:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "no OCR clock hits — widen --from/--to or check HUD",
                        "samples": [],
                    }
                ),
                flush=True,
            )
            return 2

        estimates = [s["liftoffFileSec"] for s in lock_samples]
        med = float(median(estimates))
        # consistency: how tightly estimates cluster (seconds)
        spread = float(max(estimates) - min(estimates)) if len(estimates) > 1 else 0.0
        payload = {
            "ok": True,
            "method": "ocr-median",
            "liftoffFileSec": med,
            "spreadSec": spread,
            "hitCount": len(lock_samples),
            "sampleCount": samples,
            "video": str(video),
            "samples": lock_samples,
            # Hooks for later fusion (ASR / plume / HUD arc)
            "fuse": {
                "todo": [
                    "asr_phrase_hits",
                    "plume_liftoff_vision",
                    "hud_event_labels",
                ],
                "sources": ["ocr_clock"],
            },
        }
        print(json.dumps(payload), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
