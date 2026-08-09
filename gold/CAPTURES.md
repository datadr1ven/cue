# Capture inventory (development reference)

NDJSON paths refer to external capture archives (not vendored in this repository).

## Sessions

| File | Lines (approx) | Notes |
|------|----------------:|-------|
| `aus-qual.ndjson` | 4870 | Qualifying; driver payloads may omit names |
| `aus-race.ndjson` | 7652 | Race; early `v1/drivers` + championship topics |
| `jp-practice-and-qual.ndjson` | 7866 | Two `session_key` values (practice + qualifying) |
| `jp-race.ndjson` | 4619 | Race; full driver roster early |
| `hungary-race.ndjson` | 9680 | Late join; no `v1/drivers` in file |

## 2026 permanent numbers (F1 domain roster)

| # | Acro | Name | Team |
|---|------|------|------|
| 1 | NOR | Lando Norris | McLaren |
| 3 | VER | Max Verstappen | Red Bull Racing |
| 5 | BOR | Gabriel Bortoleto | Audi |
| 6 | HAD | Isack Hadjar | Red Bull Racing |
| 10 | GAS | Pierre Gasly | Alpine |
| 11 | PER | Sergio Perez | Cadillac |
| 12 | ANT | Kimi Antonelli | Mercedes |
| 14 | ALO | Fernando Alonso | Aston Martin |
| 16 | LEC | Charles Leclerc | Ferrari |
| 18 | STR | Lance Stroll | Aston Martin |
| 23 | ALB | Alexander Albon | Williams |
| 27 | HUL | Nico Hulkenberg | Audi |
| 30 | LAW | Liam Lawson | Racing Bulls |
| 31 | OCO | Esteban Ocon | Haas F1 Team |
| 41 | LIN | Arvid Lindblad | Racing Bulls |
| 43 | COL | Franco Colapinto | Alpine |
| 44 | HAM | Lewis Hamilton | Ferrari |
| 55 | SAI | Carlos Sainz | Williams |
| 63 | RUS | George Russell | Mercedes |
| 77 | BOT | Valtteri Bottas | Cadillac |
| 81 | PIA | Oscar Piastri | McLaren |
| 87 | BEA | Oliver Bearman | Haas F1 Team |

## Topic roles

| Topic | Role in Cue F1 domain |
|-------|------------------------|
| `v1/race_control` | Flags, session lifecycle, stewards |
| `v1/position` | Order / leader changes |
| `v1/pit`, `v1/stints` | Strategy moments |
| `v1/drivers` | Roster (non-null name fields only) |
| `v1/weather` | Snapshot |
| `v1/team_radio` | Optional clips (severity 5) |
| `v1/laps`, `v1/location`, `v1/car_data` | Not subscribed / not reduced |
