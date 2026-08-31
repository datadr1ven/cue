# Webcast listen (TPlus hybrid assist)

Offline-first: extract audio from a SpaceX / Falcon webcast **recording**, run Whisper ASR, match a phrase book, print suggested TPlus `actionId`s.

**Does not auto-fire `/ops`.** HITL stays in control; this is a second screen / NDJSON feed.

## Setup (once)

```bash
# from cue repo root
python3 -m venv .venv-webcast
.venv-webcast/bin/pip install -U pip faster-whisper

# optional, for --url
# apt/pipx: yt-dlp
```

ffmpeg is required on `PATH`.

## Preferred source: SpaceX on X

SpaceX-hosted **X broadcasts** (replay) are usually the most stable. Example (ViaSat-3 F3 / last FH before Roman):

`https://x.com/i/broadcasts/1NGaradEpARJj`

```bash
# yt-dlp lives in .venv-webcast after setup
.venv-webcast/bin/yt-dlp -F 'https://x.com/i/broadcasts/1NGaradEpARJj'
# formats look like: replay-1200 (480p), replay-2750 (720p), …

# Full download is large (~1GB @480p). Prefer audio window via ffmpeg+m3u8:
M3U8=$(.venv-webcast/bin/yt-dlp -f replay-1200 -g 'URL')
ffmpeg -ss 3300 -t 1200 -i "$M3U8" -vn -ac 1 -ar 16000 clip.wav
npm run webcast:listen -- --file clip.wav --liftoff 300   # tune liftoff offset
```

Or let the CLI download (uses venv `yt-dlp` if present):

```bash
npm run webcast:listen -- --url 'https://x.com/i/broadcasts/1NGaradEpARJj' --model tiny
```

## Usage

```bash
# Local file (best for testing)
npm run webcast:listen -- --file ~/vids/falcon-heavy-replay.mp4

# Clip a window (seconds from file start)
npm run webcast:listen -- --file replay.mp4 --from 3600 --to 4500 --liftoff 3660

# Script T± gate (default ±60s vs roman-fh) — kills early host spoilers
npm run webcast:listen -- --file clip.wav --liftoff 300 --mission roman-fh
npm run webcast:listen -- --file clip.wav --liftoff 300 --show-gated   # see what was suppressed

# YouTube / X / HTTP
npm run webcast:listen -- --url 'https://x.com/i/broadcasts/…' --model tiny

# NDJSON for tooling
npm run webcast:listen -- --file replay.mp4 --json
```

**Phrase books** (auto-picked from `--mission` unless you pass `--phrases`):

| Mission | Default book |
|---------|----------------|
| `starship-*` (or vehicle/name contains Starship) | `src/webcast/phrases/starship-default.json` |
| Falcon / Roman / Starlink / other | `src/webcast/phrases/falcon-default.json` |

Override: `--phrases starship-default` or a path.

**Script gate:** with `--liftoff`, hits whose `actionId` is farther than `--gate-sec` (default 60) from the mission script’s nominal T+ are dropped. `hold` / `go` stay ungated (Starship book uses tighter hold phrases). Pass `--no-gate` to compare raw phrase noise. Offline check: `npm run smoke:webcast`.

## Clock OCR prototype (weak visual signal)

Sample frames from a saved webcast and OCR the SpaceX mission clock (RapidOCR in `.venv-webcast`):

```bash
.venv-webcast/bin/pip install rapidocr-onnxruntime opencv-python-headless pillow   # once

npm run webcast:ocr-clock -- \
  --video /tmp/roman-window.mp4 \
  --from 100 --to 700 --every 30

# Frame | OCR side-by-side in the browser
npm run webcast:ocr-clock -- \
  --video /tmp/roman-window.mp4 \
  --from 100 --to 400 --every 40 --show
# → /tmp/cue-webcast-ocr/<name>-ocr-report.html
```

Roman FH spike notes: OCR often **finds** `T±HH:MM:SS`, but **digits can be wrong**. More useful as a weak ensemble cue:

- **Sign** (T− vs T+) ≈ pre/post liftoff  
- **Δocr ≈ Δfile** between samples even when absolute is offset  
- Misses on host full-screens (no HUD) — expected  

Pair later with ASR + script gate; do not auto-fire on OCR alone.

### Schedule emitter → Telegram Approve/Dismiss

```bash
# JSON clock lock only
npm run webcast:ocr-clock -- --video /tmp/roman-window.mp4 --from 100 --to 400 --every 40 --lock

# Walk roman-fh script; dry-run
# liftoff at file 300s; start at file 0 → T−5:00, wall-clock waits
npm run webcast:schedule -- \
  --video /tmp/roman-window.mp4 --mission roman-fh \
  --liftoff-file-sec 300 --sync-file-t 0 --dry-run --once

# Replay with video: ffplay from sync point, suggests on wall clock
export TPLUS_SUGGEST_URL=https://tplus.<account>.workers.dev/suggest
export TPLUS_SUGGEST_SECRET=…
npm run webcast:schedule -- \
  --video /tmp/roman-window.mp4 --mission roman-fh \
  --liftoff-file-sec 300 --sync-file-t 0 --play
```

`--sync-file-t` is “where the playhead is **now**,” not “where the tape begins in mission time.” If sync == liftoff file time, you are already at T+0.
```

## Live shadow (mark liftoff by hand)

ASR often runs **faster than realtime**, so don’t tie the mark to Whisper’s cursor. Tie it to **your eyes** on the webcast:

1. Start audio for the same stretch you’re watching (file / clip / capture).
2. Run with `--mark-liftoff` (and `--mission` for the gate).
3. Press **`S` + Enter** when your eyes match the **start** of that audio (auto-syncs once at startup too).
4. Press **`L` + Enter** (or plain Enter) at visual liftoff — or type `9:10` / `550` for an absolute file offset.
5. Hits before the mark are **buffered**, then flushed through the script gate.

```bash
npm run webcast:listen -- \
  --file /tmp/roman-live.wav \
  --mission roman-fh \
  --mark-liftoff \
  --show-gated \
  --model tiny
```

Until you mark, gate stays off / pending. `/ops` in Telegram stays manual.

## Roman day workflow

1. Keep TPlus HITL on `roman-fh` mission script.
2. Shadow with `webcast:listen` + **`--mark-liftoff`** (or `--liftoff` on a known VOD offset).
3. Use surviving hits as prompts; still press `/ops` on video truth (approve-gate into Telegram is next).

## Baby steps checklist

1. ~~Download a past FH webcast / score phrase hits~~ (ViaSat-3 F3 spike done).
2. ~~Tighten patterns (word boundaries; landing phrases)~~.
3. ~~Script T± gating (`--liftoff` + `--mission`)~~.
4. ~~Interactive `--mark-liftoff` (wall-clock S / L)~~.
5. Soft suggest → HITL **Approve / Dismiss** on `/ops` (do not auto-fire).
6. Optional: T+ OCR sync from webcast chrome; liftoff plume vision.
7. Only then consider live HLS.