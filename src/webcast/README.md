# Webcast consumer (TPlus hybrid)

Always-on laptop process pointed at a SpaceX broadcast (or a saved VOD).  
OCR locks the mission clock (hold-aware), optional ASR adds weak evidence,  
script milestones POST to CF **`/suggest`** for **immediate fan-out**:

| Flag | Audience |
|------|----------|
| `--mode test` (default) | Admins only (`🧪 TEST` prefix) |
| `--mode ops` | All subscribers |

## Setup

```bash
python3 -m venv .venv-webcast
.venv-webcast/bin/pip install faster-whisper rapidocr-onnxruntime opencv-python-headless pillow
# optional: .venv-webcast/bin/pip install yt-dlp
# ffmpeg + ffplay on PATH
```

```bash
export TPLUS_SUGGEST_URL=https://tplus.scenicminddigital.workers.dev/suggest
export TPLUS_SUGGEST_SECRET=…          # wrangler secret put TPLUS_SUGGEST_SECRET
export TELEGRAM_TOKEN=…                # artifact upload → file_id (ops media)
export TELEGRAM_ADMIN_IDS=your_numeric_id
```

## Live / rehearsal

```bash
# Safe rehearsal — admins only
npm run webcast:live -- \
  --url 'https://x.com/i/broadcasts/1yKAPwXpMlqxb' \
  --mission starlink-sl-15-23 \
  --mode test

# Launch night — everyone
npm run webcast:live -- \
  --url 'https://x.com/i/broadcasts/1yKAPwXpMlqxb' \
  --mission starlink-sl-15-23 \
  --mode ops

# Local dry-run (no Telegram)
npm run webcast:live -- \
  --video /tmp/roman-window.mp4 \
  --mission roman-fh \
  --sync-file-t 275 --play --dry-run
```

## Other tools

| Script | Role |
|--------|------|
| `webcast:ocr-clock` | Sample VOD frames / `--image` / `--lock` / `--show` HTML |
| `webcast:schedule` | File clock-lock then wall-clock emit (`--mode test\|ops`) |
| `webcast:listen` | Offline ASR phrase spotter |

## Weak indicators (v0)

1. **Schedule + OCR clock** — primary  
2. **ASR phrases** — short footnote on the alert when present  
3. **HUD scroller “at present”** — heuristic  
4. **Vision / telemetry** — TODO hooks  
5. **Artifacts** — still uploaded for `file_id` minting; included on **ops** fan-out (test skips re-send to avoid dupes with mint)
