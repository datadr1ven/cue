#!/usr/bin/env python3
"""Extract dense frame windows around TPlus milestone emits.

Reads a webcast run archive (suggest/*.json + meta.json), maps each action's
T+ onto a local video via liftoff alignment, and writes:

  <run>/vision/frames/<actionId>_NNNN.jpg
  <run>/vision/manifest.json

Timing:
  video_center = liftoff_video_sec + clock_t_plus
  window       = [center - before, center + after] at --fps

liftoff_video_sec sources (first match):
  1. --liftoff-video-sec
  2. meta.vision.liftoffVideoSec (if previously saved)
  3. Estimate: (liftoff_wall - media_up_wall) from suggest + meta/events
  4. --liftoff-video-sec required if none of the above work

Examples:
  python extract_windows.py --run-dir ~/cue/tplus-webcast/runs/<id> --video /path/vod.mp4
  python extract_windows.py --run-dir … --download   # yt-dlp from meta.webcastUrl
  python extract_windows.py --run-dir … --video … --actions liftoff,seco --fps 2
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SAFE_ACTION = re.compile(r"[^a-zA-Z0-9._-]+")


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except ValueError:
        return None


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_suggests(run_dir: Path) -> list[dict]:
    suggest_dir = run_dir / "suggest"
    if not suggest_dir.is_dir():
        return []
    out: list[dict] = []
    for p in sorted(suggest_dir.glob("*.json")):
        try:
            doc = _load_json(p)
        except (OSError, json.JSONDecodeError):
            continue
        req = doc.get("request") or {}
        action_id = str(req.get("actionId") or p.stem)
        clock = ((req.get("evidence") or {}).get("clock") or {})
        t_plus = clock.get("tPlusSec")
        if t_plus is None:
            t_plus = req.get("scriptTPlusSec")
        if t_plus is None:
            continue
        out.append(
            {
                "actionId": action_id,
                "label": req.get("label") or action_id,
                "scriptTPlusSec": req.get("scriptTPlusSec"),
                "clockTPlusSec": float(t_plus),
                "wall": doc.get("t"),
                "suggestPath": str(p),
            }
        )
    return out


def _find_liftoff(suggests: list[dict]) -> dict | None:
    for s in suggests:
        if s["actionId"] == "liftoff" or float(s["clockTPlusSec"]) == 0.0:
            return s
    return None


def _media_up_wall(run_dir: Path, meta: dict) -> datetime | None:
    if meta.get("mediaUpAt"):
        dt = _parse_iso(str(meta["mediaUpAt"]))
        if dt:
            return dt
    events = run_dir / "events.ndjson"
    if not events.is_file():
        return None
    for line in events.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "media_up":
            return _parse_iso(ev.get("t"))
    return None


def _estimate_liftoff_video_sec(
    run_dir: Path, meta: dict, liftoff: dict
) -> tuple[float | None, str]:
    vision = meta.get("vision") if isinstance(meta.get("vision"), dict) else {}
    if vision and vision.get("liftoffVideoSec") is not None:
        return float(vision["liftoffVideoSec"]), "meta.vision.liftoffVideoSec"

    media_up = _media_up_wall(run_dir, meta)
    liftoff_wall = _parse_iso(liftoff.get("wall"))
    if media_up and liftoff_wall:
        delta = (liftoff_wall - media_up).total_seconds()
        if delta >= 0:
            return delta, "media_up_to_liftoff_wall"

    return None, "unavailable"


def _ffprobe_duration(video: Path) -> float | None:
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(video),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return float(r.stdout.strip())
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return None


def _which_ytdlp() -> str | None:
    # …/apps/tplus/src/webcast/vision/this.py → parents[5] = repo root
    repo_root = Path(__file__).resolve().parents[5]
    candidates: list[Path] = [
        repo_root / ".venv-webcast/bin/yt-dlp",
        Path.home() / "cue/.venv-webcast/bin/yt-dlp",
    ]
    which = shutil.which("yt-dlp")
    if which:
        candidates.append(Path(which))
    for c in candidates:
        if c.is_file() and (c.stat().st_mode & 0o111) != 0:
            return str(c)
    return None


def download_video(url: str, out_dir: Path) -> Path:
    ytdlp = _which_ytdlp()
    if not ytdlp:
        raise SystemExit("yt-dlp not found (expected .venv-webcast/bin/yt-dlp)")
    out_dir.mkdir(parents=True, exist_ok=True)
    # Prefer a modest mp4; fall back to best
    outtmpl = str(out_dir / "source.%(ext)s")
    cmd = [
        ytdlp,
        "--no-playlist",
        "-f",
        "bv*[height<=720]+ba/b[height<=720]/b",
        "--merge-output-format",
        "mp4",
        "-o",
        outtmpl,
        url,
    ]
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    hits = sorted(out_dir.glob("source.*"))
    hits = [h for h in hits if h.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}]
    if not hits:
        raise SystemExit(f"yt-dlp finished but no video in {out_dir}")
    return hits[0]


def extract_window(
    video: Path,
    start: float,
    duration: float,
    fps: float,
    out_pattern: Path,
) -> list[Path]:
    out_pattern.parent.mkdir(parents=True, exist_ok=True)
    # Clear prior frames for this action prefix
    stem_prefix = out_pattern.name.split("%")[0]
    for old in out_pattern.parent.glob(stem_prefix + "*.jpg"):
        old.unlink()

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(0.0, start):.3f}",
        "-i",
        str(video),
        "-t",
        f"{max(0.1, duration):.3f}",
        "-vf",
        f"fps={fps}",
        "-q:v",
        "3",
        str(out_pattern),
    ]
    subprocess.run(cmd, check=True)
    return sorted(out_pattern.parent.glob(stem_prefix + "*.jpg"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument("--video", type=Path, help="Local webcast VOD")
    ap.add_argument(
        "--download",
        action="store_true",
        help="Download meta.webcastUrl via yt-dlp into <run>/vision/video/",
    )
    ap.add_argument(
        "--liftoff-video-sec",
        type=float,
        default=None,
        help="Seconds into the video where T+0 (liftoff) occurs",
    )
    ap.add_argument("--before", type=float, default=15.0, help="Seconds before center")
    ap.add_argument("--after", type=float, default=15.0, help="Seconds after center")
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument(
        "--actions",
        default="",
        help="Comma list of actionIds to extract (default: all suggests)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print window plan only; do not run ffmpeg",
    )
    args = ap.parse_args()

    run_dir = args.run_dir.expanduser().resolve()
    if not run_dir.is_dir():
        print(f"run dir not found: {run_dir}", file=sys.stderr)
        return 1

    meta_path = run_dir / "meta.json"
    meta = _load_json(meta_path) if meta_path.is_file() else {}
    suggests = _load_suggests(run_dir)
    if not suggests:
        print("no suggest/*.json with T+ found", file=sys.stderr)
        return 1

    liftoff = _find_liftoff(suggests)
    if not liftoff:
        print("no liftoff suggest (need T+0 anchor)", file=sys.stderr)
        return 1

    liftoff_video_sec = args.liftoff_video_sec
    estimate_src = "cli"
    if liftoff_video_sec is None:
        liftoff_video_sec, estimate_src = _estimate_liftoff_video_sec(
            run_dir, meta, liftoff
        )
    if liftoff_video_sec is None:
        print(
            "Cannot determine liftoff video offset. Pass --liftoff-video-sec.",
            file=sys.stderr,
        )
        return 1

    want = {a.strip() for a in args.actions.split(",") if a.strip()}
    selected = [s for s in suggests if not want or s["actionId"] in want]
    if not selected:
        print("no actions matched --actions filter", file=sys.stderr)
        return 1

    video: Path | None = args.video.expanduser().resolve() if args.video else None
    if args.download:
        url = meta.get("webcastUrl")
        if not url:
            print("meta.webcastUrl missing; cannot --download", file=sys.stderr)
            return 1
        video = download_video(str(url), run_dir / "vision" / "video")
    if video is None:
        # reuse prior download
        prior = list((run_dir / "vision" / "video").glob("source.*")) if (run_dir / "vision" / "video").is_dir() else []
        prior = [p for p in prior if p.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}]
        if prior:
            video = prior[0]
    if video is None or not video.is_file():
        print("Need --video PATH or --download", file=sys.stderr)
        return 1

    duration = _ffprobe_duration(video)
    frames_dir = run_dir / "vision" / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    plan = []
    for s in selected:
        center = float(liftoff_video_sec) + float(s["clockTPlusSec"])
        start = max(0.0, center - args.before)
        end = center + args.after
        if duration is not None:
            end = min(end, duration)
        win_dur = max(0.1, end - start)
        safe = SAFE_ACTION.sub("_", s["actionId"]) or "action"
        pattern = frames_dir / f"{safe}_%04d.jpg"
        plan.append(
            {
                **s,
                "centerSec": round(center, 3),
                "startSec": round(start, 3),
                "durationSec": round(win_dur, 3),
                "outPattern": str(pattern),
                "safeActionId": safe,
            }
        )

    print(
        json.dumps(
            {
                "runDir": str(run_dir),
                "video": str(video),
                "videoDurationSec": duration,
                "liftoffVideoSec": liftoff_video_sec,
                "liftoffSource": estimate_src,
                "fps": args.fps,
                "windows": [
                    {
                        "actionId": w["actionId"],
                        "centerSec": w["centerSec"],
                        "startSec": w["startSec"],
                        "durationSec": w["durationSec"],
                    }
                    for w in plan
                ],
            },
            indent=2,
        )
    )

    if args.dry_run:
        return 0

    windows_out = []
    for w in plan:
        files = extract_window(
            video,
            w["startSec"],
            w["durationSec"],
            args.fps,
            Path(w["outPattern"]),
        )
        rel = [str(p.relative_to(run_dir)) for p in files]
        windows_out.append(
            {
                "actionId": w["actionId"],
                "label": w["label"],
                "scriptTPlusSec": w["scriptTPlusSec"],
                "clockTPlusSec": w["clockTPlusSec"],
                "centerSec": w["centerSec"],
                "startSec": w["startSec"],
                "durationSec": w["durationSec"],
                "frameCount": len(files),
                "frames": rel,
            }
        )
        print(
            f"[extract] {w['actionId']}: {len(files)} frames @ {w['startSec']:.1f}s",
            flush=True,
        )

    manifest = {
        "version": 1,
        "runId": meta.get("runId") or run_dir.name,
        "video": str(video),
        "videoDurationSec": duration,
        "liftoffVideoSec": liftoff_video_sec,
        "liftoffSource": estimate_src,
        "beforeSec": args.before,
        "afterSec": args.after,
        "fps": args.fps,
        "windows": windows_out,
    }
    man_path = run_dir / "vision" / "manifest.json"
    man_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # Persist liftoff alignment for reuse
    meta = {**meta, "vision": {**(meta.get("vision") if isinstance(meta.get("vision"), dict) else {}), "liftoffVideoSec": liftoff_video_sec, "liftoffSource": estimate_src}}
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(f"[extract] wrote {man_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
