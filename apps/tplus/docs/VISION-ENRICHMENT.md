# Vision enrichment (OpenCV contest + TPlus sensors)

**Goal:** Use OpenCV on launch webcast frames to **enrich** milestone alerts — better still selection and scene labels — and emit optional weak evidence. Schedule + OCR clock stay primary.

**Contest:** [OpenCV AI Competition 2026 (AWS)](https://opencv26.devpost.com/) · final due **2026-10-26** · requires substantive **OpenCV 5** + a meaningful **AWS** component.

**Related:** [SENSORS.md](./SENSORS.md) · [EVENT-RULES.md](./EVENT-RULES.md) · scaffold under `src/webcast/vision/`.

---

## Product angle (what we demo)

When TPlus fires a milestone (liftoff, Max-Q, SECO, landing burn, …):

1. Score a short buffer of nearby frames with OpenCV.
2. Prefer a **rich** still over a black / HUD-only / replay-graphic frame.
3. Attach a short **scene tag** (and confidence) to evidence / footnotes.
4. Do **not** require vision to gate public alerts in v0 (soft vote only).

Latency is fine: enrichment may finish 1–5s after emit; contest eval can be fully offline.

---

## Data we already have

Desktop run archives (`~/cue/tplus-webcast/runs/`):

| Asset | Use |
|-------|-----|
| `suggest/*.json` | Milestone times, script T+, current artifacts |
| `frames/*.jpg` | Emit-time stills (sparse — often 1 per action) |
| `script.json` / `events.ndjson` | Plan + emit log |
| `meta.json` | Mission / webcast pointers |

**Gap for a real demo:** emit stills alone are too few. Next data step is a **frame library**: for each flight, extract 1–2 fps (or burst windows around each `actionId`) from the saved webcast / X broadcast into `runs/<id>/vision/frames/`.

---

## Label set (v0)

Keep labels coarse and contest-judge-readable:

| Label | Meaning |
|-------|---------|
| `plume_on` | Bright exhaust / flame visible |
| `plume_off` | Vehicle coast / cutoff look |
| `pad_or_tower` | Ground infrastructure dominant |
| `vehicle_air` | Stack / stage clearly in flight |
| `landing_burn` | Landing / boostback burn look |
| `hud_heavy` | Telemetry / animation / graphic dominates |
| `low_value` | Black, blur, logo card, unusable |

Optional later: `engine_out_suspect`, `stage_sep`, `fairing` — only after v0 works.

Gold format: JSONL next to frames, see `src/webcast/vision/labels.schema.json`.

---

## Eval (what “better” means)

Offline harness (`vision/eval_enrich.py` stub):

1. For each archived emit, take candidate frames in `[t−N, t+N]`.
2. Rank by OpenCV score (prefer `plume_*` / `vehicle_air` / `landing_burn` over `hud_heavy` / `low_value`).
3. Metrics vs human gold (or vs “emit frame was low_value”):
   - **Pick quality:** % of selected frames that are not `low_value` / `hud_heavy`
   - **Tag accuracy:** top-1 label vs gold
   - **Latency:** p50/p95 ms per frame and per emit window (local + AWS)

Success for a demo video: side-by-side “naive still” vs “enriched still” on 3–5 flights, plus a small table of numbers.

---

## AWS slice (required for contest)

Minimal meaningful cloud path:

1. Upload `vision/` frame packs to **S3**.
2. Run OpenCV 5 batch on **EC2 Graviton** or **Lambda container** / batch job (COOL path if chasing that special prize).
3. Write scores JSON back to S3; local eval reads results.

Local-only OpenCV is fine for iteration; contest submission must show AWS in the architecture and demo.

---

## Next steps (ordered)

| # | Step | Owner-ish | Done when |
|---|------|-----------|-----------|
| 1 | Register / confirm Devpost entry + rules | you | team on [opencv26.devpost.com](https://opencv26.devpost.com/) |
| 2 | Frame extraction tool (yt-dlp / archive → `vision/frames` around emits) | code | `vision/extract_windows.py` (scaffold done) · ≥3 flights with dense windows |
| 3 | Label 200–500 frames (v0 labels) | human + light assist | `labels.jsonl` checked in or private gold |
| 4 | OpenCV baseline (color/motion/HUD heuristics → labels) | code | beats random on eval |
| 5 | Optional tiny classifier (OpenCV DNN / ONNX) if heuristics plateau | code | measurable lift |
| 6 | AWS batch path + README | code | reproducible from clean checkout |
| 7 | Demo video + Devpost writeup | you | before **2026-10-26** |

Scaffold for 2–4 lives in `apps/tplus/src/webcast/vision/` (this pass).

---

## Non-goals (this phase)

- Replacing OCR clock
- Live hard-gating of Telegram alerts
- Scraping GameChanger or other closed score apps
- Claiming official SpaceX telemetry
