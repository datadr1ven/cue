# Webcast consumer (TPlus hybrid)

Always-on laptop process pointed at a SpaceX broadcast (or a saved VOD).  
OCR locks the mission clock (hold-aware), optional ASR adds weak evidence,  
script milestones POST to CF **`/suggest`** → admin **Approve / Dismiss** with  
**artifact toggles** (choose which photos/audio fan out).

## Setup

```bash
python3 -m venv .venv-webcast
.venv-webcast/bin/pip install faster-whisper rapidocr-onnxruntime opencv-python-headless pillow
# optional: .venv-webcast/bin/pip install yt-dlp
# ffmpeg + ffplay on PATH
```

Secrets / env for live suggests:

```bash
export TPLUS_SUGGEST_URL=https://tplus.scenicminddigital.workers.dev/suggest
export TPLUS_SUGGEST_SECRET=…          # wrangler secret put TPLUS_SUGGEST_SECRET
export TELEGRAM_TOKEN=…                # same bot — artifact upload → file_id
export TELEGRAM_ADMIN_IDS=your_numeric_id
```

## Live (launch day)

```bash
npm run webcast:live -- \
  --url 'https://x.com/i/broadcasts/1yKAPwXpMlqxb' \
  --mission starlink-sl-17-50
```

- Parks until HLS/media exists  
- OCR every ~5s; stalls detected as holds  
- ASR every ~10s → evidence on suggest cards  
- Artifacts: current frame uploaded as toggleable photo (more hooks TODO)

Dry-run / rehearsal on a file:

```bash
npm run webcast:live -- \
  --video /tmp/roman-window.mp4 \
  --mission roman-fh \
  --play --dry-run
```

## Other tools

| Script | Role |
|--------|------|
| `webcast:ocr-clock` | Sample VOD frames / `--image` / `--lock` / `--show` HTML |
| `webcast:schedule` | File clock-lock then wall-clock script emit (no live park) |
| `webcast:listen` | Offline ASR phrase spotter |

## Weak indicators (v0)

1. **Schedule + OCR clock** — primary  
2. **ASR phrases** — evidence bullets  
3. **HUD scroller “at present”** — OCR boxes in bottom mid band (heuristic)  
4. **Vision classifiers / telemetry** — TODO hooks in `evidence.todo`  
5. **Artifacts** — op toggles ✅/⬜ before Approve  

## Approve UI

Telegram: toggle artifact buttons, then **Approve selected** or **Dismiss**.  
Subscribers get alert text + only selected media.
