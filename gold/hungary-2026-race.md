# Gold (v0) — 2026 Hungarian Grand Prix

**Source:** F1.com race report (not hand-watched live notes)  
https://www.formula1.com/en/latest/article/norris-beats-verstappen-and-antonelli-to-victory-in-dramatic-hungarian-gp.5JQmohRAKABD2asRsMWogj  

**Capture alignment:** `latest-artifacts/hungary-race.ndjson` (+ part1/part2), `hungary-race.log`  

**How to read this file:**  
Each `WANT` line is a notification a clued-in-but-not-watching fan might want.  
Tags are candidate **moment types** for the engine. Severity: `9` = interrupt now, `6–7` = batch OK, `4–5` = only if following / quiet window.  

Report-based gold is **biased toward narrative highlights** (good). It under-specifies exact wall times and may miss pure telemetry moments (gaps, exact SC deploy second).

---

## Where to put NDJSON timestamps

**→ Fill in the table in [Timestamp alignment (you fill this in)](#timestamp-alignment-you-fill-this-in) below.**  
Do **not** try to wedge times into the WANT narrative tables (those stay human-readable story beats).

### What to write in each row

| Column | What it means | Example |
|--------|----------------|---------|
| `id` | Same as WANT id (`R18`, `R21`, …) | `R18` |
| `t_feed` | Best timestamp from the capture — prefer `payload.date`, else `receivedAt` | `2026-07-26T14:12:03.120000` |
| `topic` | MQTT topic of the line you matched | `v1/race_control` |
| `match` | Short quote / key fields so we can re-find the line | `VSC DEPLOYED` or `driver 81 pit lap 33` |
| `file` | Which ndjson if not the main one | `hungary-race.ndjson` or `part2` |
| `notes` | Optional: uncertain, multi-line event, etc. | `approx; first VSC msg` |

**Priority to timestamp (sev ≥ 8 first):** R2, R14, R15, R18, R19, R21, R22 — then any others you easily find.

**Good enough:** one solid `t_feed` per id. You don’t need millisecond perfection or every R-row.

**How to find a line (example):**

```bash
# VSC / chequered / penalties often live in race_control
rg -n "VSC|SAFETY CAR|CHEQUERED|PENALTY|PIASTRI|Piastri" latest-artifacts/hungary-race.ndjson | head

# pits: topic v1/pit, driver_number 81 = Piastri, 4 = Norris, 44 = Hamilton (check drivers)
rg -n '"topic": "v1/pit"' latest-artifacts/hungary-race.ndjson | head
```

Copy `payload.date` (or `receivedAt`) into `t_feed`.

---

## Qualifying (from same article — pre-race context)

| # | WANT (notification sketch) | tags | sev |
|---|----------------------------|------|-----|
| Q1 | Norris takes pole by 0.012s over Hamilton; Leclerc P3, Antonelli P4 | `session.qualifying_result`, `order.pole` | 8 |
| Q2 | Grid penalties: Hamilton **and** Antonelli each **−3 places** (HAM impeding PIA; ANT yellow-flag delta) | `penalty.grid`, `stewards` | 8 |
| Q3 | Revised front: Norris pole, Leclerc P2, Piastri P3, Verstappen P4; Hamilton P5, Antonelli P7 | `order.grid_final` | 7 |

*(Soft-launch note: quali moments need phase/chequered + classification; penalties are high value.)*

---

## Race — notification timeline (desired)

Times are **approximate race structure** from the report (lap-based where given).

| # | When | WANT (what the alert should convey) | tags | sev |
|---|------|-------------------------------------|------|-----|
| R1 | Pre-start | Formation / grid: Norris on pole; tyre split — NOR/PIA/VER **mediums**, LEC/HAM **softs** (aggressive) | `session.starting`, `strategy.tyre_grid` | 6 |
| R2 | Lap 1 | Lights out: Norris keeps P1 into T1; **Piastri passes Norris for the lead** at T2 cut-back | `race.start`, `order.leader_change`, `overtake.lead` | 9 |
| R3 | Lap 1 | Also lap 1: Hamilton past Leclerc for P4; contact/wheels with Verstappen; **Russell anti-stall → ~P21** from P6 | `order.big_swing`, `focus.if_russell` | 7 |
| R4 | Early | Settled order: **Piastri leads** Norris, then VER–HAM–LEC; Antonelli P6 after Russell’s drop | `order.snapshot` | 5 |
| R5 | ~Lap 14 | First front-runner stop: **Hamilton soft→hard**, rejoins ~P9, then overtakes Lindblad | `strategy.pit`, `focus.if_hamilton` | 6 |
| R6 | Lap 15–16 | Verstappen pits to hards; **overtakes Hamilton** into T1 after out-lap | `strategy.pit`, `overtake`, `focus.if_either` | 6 |
| R7 | Lap 17–18 | McLaren/Ferrari stop cycle: PIA & LEC in, then Norris; Piastri **holds net lead** at pit exit over Norris | `strategy.pit_wave`, `order.leader` | 7 |
| R8 | Lap 22 | Antonelli stops (was looking one-stop-ish) → **also two-stopping**; Piastri back in race lead | `strategy.pit`, `focus.if_antonelli` | 6 |
| R9 | Mid | Norris all over Piastri; team radio “I’m miles faster” / dirty air — **team orders tension** (notify lightly, not every radio) | `drama.team_orders` | 5 |
| R10 | Mid | **Bottas retires** (overheating brakes / smoke) | `retirement` | 7 |
| R11 | Lap 30 | Hamilton **second stop** (hards again); strategy concern “trouble at the end?” | `strategy.pit`, `focus.if_hamilton` | 5 |
| R12 | Lap 33 | **Piastri second stop** → Norris in clear air, builds tyre offset for undercut/overcut flip | `strategy.pit`, `order.lead_battle` | 7 |
| R13 | ~Lap 37+ | Leclerc second stop; Norris still extending — net pit window opening vs Piastri | `strategy.offset` | 6 |
| R14 | Mid–late | **Piastri hits Sainz** (blues / traffic, T2) — race swings to Norris; stewards **investigate** | `incident.collision`, `stewards.investigation` | 8 |
| R15 | End Lap 39 | **Norris second stop** → rejoins **ahead of Piastri** = net race lead | `strategy.pit`, `order.leader_change` | 9 |
| R16 | After | Verstappen pits for **softs** for final stint (“have some fun”) | `strategy.pit`, `strategy.soft_finish` | 6 |
| R17 | ~Lap 54 | Antonelli pits again (tyre life) — podium fight shape changes | `strategy.pit`, `focus.if_antonelli` | 6 |
| R18 | ~final 15 laps | **Piastri gearbox / stops on track** → **VSC** | `retirement`, `flag.vsc` | 9 |
| R19 | VSC | Norris, Hamilton, Leclerc **pit under VSC**; Verstappen & Antonelli stay out → **VER P2, ANT podium shape** | `flag.vsc`, `strategy.vsc_pit` | 8 |
| R20 | VSC exit | Hamilton briefly ahead of Antonelli on road; **gives place back** (VSC white-line / timing) | `stewards.procedure`, `order.swap` | 7 |
| R21 | Finish | **Chequered: Norris wins** (+15s) from Verstappen, Antonelli; first McLaren/Norris win of 2026 | `session.chequered`, `order.final` | 9 |
| R22 | Post | Hamilton **+5s pit-lane speeding** → drops behind Leclerc (HAM P5, LEC P4) | `penalty.time`, `order.final_adjusted` | 8 |
| R23 | Post | Sainz +5s (PIA incident); Bearman +5s (blues) — lower priority unless following | `penalty.time` | 4 |
| R24 | DNFs board | Retirements: Piastri (gearbox), Perez (front-left), Bottas (brakes) | `session.dnfs` | 6 |

### Final classification (must-get end card)

| Pos | Driver | Notes for alerts |
|-----|--------|------------------|
| 1 | Norris | Winner |
| 2 | Verstappen | +15.080s |
| 3 | Antonelli | Podium |
| 4 | Leclerc | After HAM penalty |
| 5 | Hamilton | +5s pit speeding |
| 6 | Hadjar | |
| 7 | Russell | Recovery from ~P21 |
| 8–10 | Lawson, Hulkenberg, Lindblad | |
| DNF | Piastri, Perez, Bottas | |

---

## Timestamp alignment (you fill this in)

Link each WANT `id` to a real line in the capture. Leave cells blank if you skip that row.

### Race (high priority first)

**Status:** `auto` = filled by agent from ndjson grep (2026-08-09); please **correct** if wrong.  
`missing` = not found in capture (gold beat may still be valid for product; feed gap).  
`todo` = not auto-filled yet.

| id | t_feed (payload.date or receivedAt) | topic | match (short) | file | notes |
|----|-------------------------------------|-------|---------------|------|-------|
| R2 | 2026-07-26T13:03:46.943000 | v1/position | P1 → driver 81 (Piastri) | hungary-race.ndjson | **auto** first P1 change after start; Norris=#1 in 2026? |
| R14 | | | | | **missing** in race_control — no PIA/SAI collision msg in this capture |
| R15 | | v1/pit? | | | **todo** / weak — pit stream incomplete vs article (see below) |
| R18 | 2026-07-26T14:22:55+00:00 | v1/race_control | VSC DEPLOYED | hungary-race.ndjson | **auto** (stoppage cause not explicit in RC) |
| R19 | 2026-07-26T14:22:55+00:00 | v1/race_control | VSC DEPLOYED | hungary-race.ndjson | **auto** same anchor; VSC ENDING 14:24:13 |
| R21 | 2026-07-26T14:43:14+00:00 | v1/race_control | CHEQUERED FLAG | hungary-race.ndjson | **auto** |
| R22 | 2026-07-26T14:36:27+00:00 | v1/race_control | 5 SECOND TIME PENALTY FOR CAR 44 (HAM) - SPEEDING IN THE PIT LANE | hungary-race.ndjson | **auto** (noted 14:30:01, investigated 14:31:27) |
| R1 | 2026-07-26T13:03:18.360000+00:00 | v1/race_control | SESSION STARTED | hungary-race.ndjson | **auto** |
| R3 | | | | | **todo** Russell swing — needs position deltas |
| R5 | | v1/pit | driver 44 lap 13 | hungary-race.ndjson | **auto-ish** only HAM pits in file: laps **13, 56** (article also mid-race stops) |
| R6 | | | | | **todo** |
| R7 | | | | | **todo** |
| R8 | | v1/pit | driver 12 lap 22 | hungary-race.ndjson | **auto-ish** ANT pit lap 22 matches article |
| R10 | | | | | **missing** no Bottas retirement RC line |
| R11 | | | | | **todo** article lap 30 HAM stop — **not** in pit topic (gap) |
| R12 | | | | | **todo** |
| R16 | | | | | **todo** |
| R17 | | v1/pit | driver 12 lap 53 | hungary-race.ndjson | **auto-ish** ANT late stop ~lap 53 (article ~54) |
| R20 | | | | | **missing** VSC white-line HAM/ANT — not in RC |
| R23 | 2026-07-26T14:25:36+00:00 | v1/race_control | 5s BEA blue flags | hungary-race.ndjson | **auto** (Bearman); Sainz +5s **missing** in RC |
| R24 | | | | | **partial** DNFs not cleanly listed in RC |

**Capture notes (agent):** full file `hungary-race.ndjson` (~9680 lines). part1/part2 = restart concat only.  
Pit topic looks **thin** vs race report (e.g. driver 81 only one pit msg lap 16; no driver 4 pit msgs — Norris may be **#1** in 2026). Position stream shows few P1 changes (81→1→12→81) — **not** a full lead history through Norris win.

### Qualifying (only if you have a **quali** ndjson for this weekend)

Race ndjson will **not** contain Q1–Q3. Use e.g. `hungary-qual*.ndjson` if aligning these.

| id | t_feed | topic | match | file | notes |
|----|--------|-------|-------|------|-------|
| Q1 | | | | | pole |
| Q2 | | | | | grid penalties |
| Q3 | | | | | revised grid / session end |

### Example of a filled row

| id | t_feed | topic | match | file | notes |
|----|--------|-------|-------|------|-------|
| R21 | 2026-07-26T14:39:12.000000 | v1/race_control | CHEQUERED FLAG | hungary-race.ndjson | first chequered msg |

---

## Preference overlays (examples)

If user follows **only Hamilton**:
- Elevate: R5, R6, R11, R19–R22, final P5 + penalty explanation  
- Still send: R2 leader change, R18 VSC, R21 winner (global severity 9)

If user follows **Piastri**:
- Elevate: R2 lead, R7–R15 battle, R14 incident, R18 DNF/VSC  
- End card: DNF + reason

If user follows **Antonelli**:
- Elevate: grid drop (Q), R8/R17 strategy, R19–R21 podium  

---

## Explicitly do **not** spam (anti-gold)

From report + our bad bot logs — **skip as standalone alerts**:

- Every midfield pit  
- “Team radio available” links  
- Every track-limits delete  
- Continuous “X leads” with no change  
- Verstappen damping/shift radio unless it becomes a retirement or big swing  
- Full stint tables every 10 minutes  

---

## Moment-type inventory (extract for engine v0)

Minimum set this race needs:

```
session.starting
session.chequered
race.start
order.leader_change
order.snapshot          # rare; after big phases only
order.final
order.final_adjusted    # penalties after flag
order.big_swing         # e.g. Russell P6→P21
strategy.pit
strategy.pit_wave
strategy.tyre_grid
strategy.vsc_pit
strategy.offset         # optional / higher difficulty
flag.vsc
flag.safety_car         # not this race, keep type
flag.red
incident.collision
stewards.investigation
penalty.grid
penalty.time
retirement
overtake                # only lead / focus / podium-relevant
overtake.lead
drama.team_orders       # low rate, optional
```

---

## Detectability vs OpenF1 NDJSON (rough)

| WANT | Likely in feed? | Notes |
|------|-----------------|-------|
| Leader change lap 1 | Yes if position stream | Need position deltas, not only race_control |
| Pits + compounds | pit + stints | Good |
| VSC / SC | race_control | Good — instant path |
| Piastri–Sainz incident | race_control investigate/penalty | Message text |
| Retirement / stoppage | race_control + position | |
| VSC white-line Hamilton/Antonelli | **Hard** | May only appear as order swap or not at all |
| Team orders radio content | team_radio URL only | Don’t depend on transcript |
| +5s pit speeding | race_control / stewards | Often present |
| Pole by 0.012 | quali session_result | Separate session |

Use this table when building detectors: implement **easy high-sev** first (flags, pits for leaders/focus, leader change, chequered, penalties, DNF).

---

## Soft-launch subset (if we only ship thin v0)

Must-detect for “clued in” on a race like this:

1. Race start + early leader change  
2. Safety/VSC/red  
3. Focus-driver pits + big position change  
4. Lead change (anyone)  
5. Investigation/penalty involving leaders or focus  
6. Retirement of leader/focus/front-runner  
7. Chequered + top 3 + focus result (+ post-flag penalty if it changes podium)

That is **~8–15 messages / race**, not 48 stenography lines.

---

## Next steps (for agent / us)

1. Map WANT rows → lap/time in `hungary-race.ndjson` where possible  
2. Implement detectors for soft-launch subset only  
3. Diff engine output vs this file (recall of sev≥7 first)  
4. Optional: user trims this list after one rewatch (“I wouldn’t have wanted R9”)  

---

## Provenance

- Article date/context: 26 Jul 2026 Hungarian GP  
- Gold file created: 2026-08-09  
- Authoritative for **story beats**, not millisecond timing  
