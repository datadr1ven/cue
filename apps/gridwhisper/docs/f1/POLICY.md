# F1 moment policy

How Cue decides which OpenF1 events become sparse alerts. **Runtime filtering lives in code** (`packages/cue/src/engine/domains/f1/moments.js`, `packages/cue/src/engine/domains/f1/snapshot.js`); this doc preserves *why*.

## Principles

1. **Do not invent detectors from a single race.** Implement only what repeats across a frozen evaluation set, or is unambiguously high-severity everywhere.
2. **Prefer silence over noise.** Processional pulses, tyre changes under red, and steward spam that drown signal must be suppressed.
3. **Prefer REST downloads for gold evaluation** when MQTT is thin or floody (sprint boards, reconnect gaps).
4. **Gate still applies** after detection (`ENGINE_MIN_SEVERITY`, dedupe, cooldowns in `packages/cue/src/engine/gate.js`).

## Evaluation corpus (external captures)

Large NDJSON is **not** vendored. Keep captures locally (e.g. `testdata/`, `dutch-2026/` — gitignored).

| Session | Typical local path | Role |
|---------|-------------------|------|
| Brazil 2024 race `9636` | `testdata/brazil-2024-race-9636-downloaded.ndjson` | Wet + SC/VSC/red + charge |
| Silverstone 2026 race `11326` | `testdata/silverstone-2026-race-11326-downloaded.ndjson` | Late SC + finish under SC + mechanical |
| Monaco 2024 race `9523` | `testdata/monaco-2024-race-9523-downloaded.ndjson` | Processional after lap-1 red |
| Zandvoort 2026 sprint `11348` | `dutch-2026/sprint-downloaded.ndjson` | Live processional control |

In-repo smoke only: `packages/cue/examples/f1/smoke-two-alerts.ndjson`.

## Capability → code

| Capability | Policy | Primary code |
|------------|--------|----------------|
| SC deploy | Emit once; don’t clear on `IN THIS LAP`; avoid false re-DEPLOYED | `f1/moments.js` (`flag.safety_car`) |
| VSC deploy | Match `VIRTUAL SAFETY CAR` as well as `VSC DEPLOYED` | `f1/moments.js` (`flag.vsc`) |
| Red flag | High sev; suppress long lane pits under red | `f1/moments.js` + pit suppress |
| Leader change | Race/sprint; not processional noise | `f1/moments.js` (`order.leader_change`) |
| Order snapshot | Suppress **unchanged** pulse | `f1/moments.js` (`order.snapshot`) |
| Finish / chequered | Include “under safety car” when applicable | `f1/moments.js` |
| Retirement / DNF | Incomplete lap under SC/red, or `session_result` DNF | `f1/moments.js` |
| SC unlap messaging | Lower sev informational | `f1/moments.js` (`flag.sc_unlap`) |
| SC pit vs stay-out | Top-5 under-SC pits sev 8; stay-out inherit moment | `f1/moments.js` (`strategy.*`) |
| Red-flag / >90s pits | Suppress tyre-change spam | `f1/moments.js` |
| Session kind | Practice/quali/sprint modes change volume | `f1/snapshot.js` + `ENGINE_SESSION_KIND` |
| Roster labels | 2026 permanent numbers | `f1/roster.js` |

Paths above are under `packages/cue/src/engine/domains/`.

## Implemented decisions (corpus → commits)

Frozen evaluation pass (2026-08-22), one commit each:

1. `VIRTUAL SAFETY CAR` → `flag.vsc` (`f092d1b`)
2. SC deploy dedupe + don’t clear on `IN THIS LAP` (`0d9c00d`)
3. Suppress unchanged `order.snapshot` (`79bd94c`)
4. Suppress red-flag / >90s lane pits (`7b27bad`)
5. Chequered · under safety car (`16a980d`)
6. Retirement: incomplete lap + SC/red, or `session_result` DNF (`6e3911d`)
7. `flag.sc_unlap` (`efc4686`)
8. Top-5 SC pits sev 8 + `strategy.sc_stay_inherit` (`2a0212b`)

## Open gaps (as of corpus freeze)

- Named DNF / beached coverage still weak on some sessions  
- Restart order / standing-start messaging (P2)  
- Mechanical undoing (slow double pit, puncture) still soft (P2)  
- Penalty squelch under steward floods (P2)  

Re-open gaps only with evidence from **≥2** sessions (or one unambiguous high-sev case).

## How to extend

1. Capture or download a session (see GridWhisper app docs / `npm run download`).  
2. Replay offline: `npm run replay -- path.ndjson` (force `ENGINE_SESSION_KIND` when needed).  
3. Diff alerts vs intent; add a detector or suppress rule in `moments.js` / `packages/cue/src/engine/domains/f1/snapshot.js`.  
4. Prefer a tiny synthetic fixture under `examples/f1/` for the regression, not a full race dump.  
5. Update this POLICY with capability, priority, and commit SHA.
