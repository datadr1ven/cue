# Gold (v0 sketch) — 2026 Australian Grand Prix

**Recaps:**  
- https://www.formula1.com/en/latest/article/russell-wins-action-packed-australian-gp-from-antonelli-as-mercedes-secure-1.4WRxPAtF4dFtrKCsWIiQX2  
- https://www.formula1.com/en/latest/article/australia-lowdown-2026-all-the-key-moments-as-mercedes-enjoy-a-perfect-start.538A9JyEiem5LTfO4gkmr2  

**Capture:** `latest-artifacts/aus-race.ndjson` (session_key 11234)

## High-severity WANT (for engine recall)

| id | Story beat | tags | sev |
|----|------------|------|-----|
| A1 | Piastri spins on way to grid — DNS home race | pre-race / DNS | 8 |
| A2 | Hulkenberg wheeled off grid — DNS | DNS | 7 |
| A3 | Lights out: Leclerc T1 lead from P4 | order.leader_change | 9 |
| A4 | Russell ↔ Leclerc lead swaps early | order.leader_change | 8 |
| A5 | Hadjar retires smoke → **VSC**; Merc pit, Ferrari stay out | flag.vsc, strategy | 9 |
| A6 | Bottas stops → **VSC** again; Ferrari stay out | flag.vsc | 9 |
| A7 | Merc one-stop holds; Russell wins, Antonelli P2, LEC/HAM 3–4 | session.chequered | 9 |
| A8 | Colapinto stop-go starting procedure | penalty | 7 |

Use `node engine/cli-replay.js latest-artifacts/aus-race.ndjson` to compare.
