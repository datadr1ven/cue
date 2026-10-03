# F1 event rules (human guide)

What GridWhisper *means* to alert on, in plain language.  
**Source of truth:** `packages/cue/src/engine/domains/f1/moments.js` (+ `snapshot.js`, `render.js`).  
Philosophy / corpus: [POLICY.md](./POLICY.md).

---

## Brief — what fans should see

Cue turns a firehose (SignalR or OpenF1) into a **sparse** stream. Prefer silence over noise. Mode is forced by session-ctl (`ENGINE_SESSION_KIND`).

### Practice (FP1–FP3)

| You get | You don’t get |
|---------|----------------|
| Session start / finish | Position thrash, pits, radios |
| Finish recap (fastest, compounds, busiest pitters) | “Someone went P7→P4” |

### Qualifying / sprint shootout (Q1–Q3 / SQ)

| You get | You don’t get |
|---------|----------------|
| Segment start (Q1 / Q2 / Q3) | Race-style big swings / leader thrash |
| A few session-bests in **Q1/Q2** (capped, warmed up) | Session-best spam in **Q3** (time-sheet drama owns that) |
| Chequered + “into the cut” board drama | Every purple sector |
| Q1/Q2 **cut summary** when the *next* segment starts | |
| Q3 **provisional pole** at the flag | |
| Q3 **provisional top‑3 refresh** if P1–P3 change after the flag | Fixed “settle timer” (none — board-driven only) |
| Near-miss / provisional P1 flips on the time sheet (Q3) | Grid penalties / Sunday grid (not in live feeds) |

### Race / sprint race

| You get | You don’t get |
|---------|----------------|
| Green / chequered / finish (incl. under SC when relevant) | Processional “order pulse” every few seconds |
| Leader change into P1 | Tiny place swaps |
| Big swings only when **≥5 places**, green, not pit cascade / lights-out noise | |
| Pits (compound when known); top‑5 under-SC pits louder | Long red-flag tyre-change pit spam |
| SC / VSC / red; SC stay-out inherit | |
| Sparse top‑3 team radio | Every radio clip |
| Rain *starting* (cooled down) | Rainfall bit flapping |
| Stewards investigation / time penalty when RC text looks serious | Full steward PDF dump |

**Also:** severity gate + dedupe still apply after detection (`ENGINE_MIN_SEVERITY`, etc.).

---

## Appendix — moment catalog & gates

Severities are detector defaults before the global gate.

### Session lifecycle

| Type | When | Notes |
|------|------|--------|
| `session.started` | Race/sprint green | Not used for Q segment labels |
| `quali.segment_start` | Q1/Q2/Q3 (or SQ) green | |
| `session.chequered` / `session.finished` | Flag / end | Race may defer board until lap times settle |
| `quali.chequered` | Q1/Q2 flag when cut not deferred | |
| `quali.cut` | Next segment starts after Q1/Q2 | “Out (N): … · through to Q*” |
| `quali.pole` | First Q3/SQ3 chequered | Provisional; “cars on a lap can still improve” |
| `quali.pole_change` | After that pole, **any P1–P3** change | Same copy shape; “was …” only if P1 flipped |

### Qualifying time sheet

| Type | When | Gates |
|------|------|--------|
| `quali.session_best` | New session-best lap | Q1/Q2 only (not Q3); ignore first **8 min** of segment; ≥**0.1s** improve; max **3**/segment; **60s** between alerts |
| `quali.prov_p1` | Time-sheet provisional P1 change | Q3; warmup **4 min**; after flag, P1 flips owned by pole / pole_change |
| `quali.close_to_pole` | Personal best within **0.15s** of P1 | Q3 time sheet |
| `quali.into_cut` | After Q1/Q2 flag, car jumps from outside cut → transfer slot | Until next segment |

**Cut sizes (2026 22-car):** Q1 eliminate enough that **16** go through; Q2 → **10** into Q3.

### Race order & strategy

| Type | When | Gates |
|------|------|--------|
| `order.leader_change` | Car moves into P1 | Race/sprint only |
| `order.big_swing` | \|Δpos\| ≥ **5** | Race/sprint; track **green**; not within **45s** of own pit; first **90s** of race: only drops ≥ **8**; per-driver cooldown **90s** |
| `order.snapshot` | Quiet top‑5 pulse | Only if board **changed**; quiet ≥ **12 min** (`ORDER_PULSE_MS`) |
| `strategy.pit` | Pit + compound when known | Race/sprint; suppress red / very long lane |
| `strategy.sc_stay_inherit` | Stay-out inherits place after top‑5 SC pit | Under SC; within ~3 min of that pit |
| `retirement` | Incomplete lap under SC/red, or result DNF | |

### Flags, weather, stewards, radio

| Type | When | Gates |
|------|------|--------|
| `flag.safety_car` | SC deployed | Dedupe; don’t clear on “IN THIS LAP” alone |
| `flag.vsc` | VSC / “VIRTUAL SAFETY CAR” | |
| `flag.red` | Red flag | High sev |
| `flag.sc_unlap` | Unlap messaging | Informational |
| `weather.rain` | Rainfall goes 0→>0 while session active | Cooldown **~40 min** |
| `weather.rain_risk` | (when staged) | |
| `penalty.time` / `stewards.investigation` | Race-control text heuristics | Sev scaled by who’s involved / session phase |
| `radio.clip` | Team radio | Max **5**/session; gap **8 min**; prefer top‑3 and within **4 min** of a key moment; ambient top‑3 possible after **18 min** with none |

### Explicitly out of scope (today)

- **Grid penalties** / Sunday starting grid (OpenF1 `starting_grid` ≠ live RC; not alerted)
- Practice position / pit chatter
- Qualifying “gained 2 places on a flyer” as a race-style swing
- Timer-based “Q3 settled” report (use top‑3 change + eventual silence instead)

---

## Cheat sheet — “why didn’t I get X?”

| Expectation | Likely reason |
|-------------|----------------|
| HAM P4→P2 in Q3 as a “swing” | Swings are race-only and need ≥5 places; Q3 uses provisional top‑3 |
| Final Q3 order after flying laps | Need a P1–P3 change (now) or a future dedicated settle beat; no timer |
| Hadjar “P8” | Quali P3 + grid penalty — not in SignalR/OpenF1 RC the same way |
| Every purple in Q1 | Session-best capped / warmed up / cooled down |
| Radios all session | Hard cap + spacing + top‑3 preference |
