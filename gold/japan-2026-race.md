# Gold (v0 sketch) — 2026 Japanese Grand Prix

**Recap:**  
https://www.formula1.com/en/latest/article/antonelli-takes-championship-lead-after-surging-to-victory-in-japan-from.4EC4uZc29IUEO2iE5nKpUp  

**Capture:** `latest-artifacts/jp-race.ndjson` (session_key 11253)

## High-severity WANT

| id | Story beat | tags | sev |
|----|------------|------|-----|
| J1 | Start: Piastri seizes lead T1; Merc drop | order.leader_change | 9 |
| J2 | Russell challenges Piastri for lead | order / battle | 6 |
| J3 | Bearman heavy crash T13 → **Safety Car** lap ~22 | flag.safety_car | 9 |
| J4 | Antonelli pits under SC from net lead → keeps P1 | strategy.pit + SC | 8 |
| J5 | Restart: Antonelli holds; builds gap | order | 6 |
| J6 | Chequered: Antonelli wins, Piastri P2, Leclerc P3 | session.chequered | 9 |
| J7 | Championship: Antonelli becomes leader | post / optional | 5 |

Use `node engine/cli-replay.js latest-artifacts/jp-race.ndjson`.
