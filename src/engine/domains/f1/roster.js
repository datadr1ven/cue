/**
 * 2026 permanent numbers + live overrides from v1/drivers.
 * Late-join captures (e.g. hungary-race) may never get drivers topic.
 */

/** @type {Record<number, { broadcast: string, full: string, team: string, acro: string }>} */
export const ROSTER_2026 = {
  1: { broadcast: "L NORRIS", full: "Lando NORRIS", team: "McLaren", acro: "NOR" },
  3: { broadcast: "M VERSTAPPEN", full: "Max VERSTAPPEN", team: "Red Bull Racing", acro: "VER" },
  5: { broadcast: "G BORTOLETO", full: "Gabriel BORTOLETO", team: "Audi", acro: "BOR" },
  6: { broadcast: "I HADJAR", full: "Isack HADJAR", team: "Red Bull Racing", acro: "HAD" },
  10: { broadcast: "P GASLY", full: "Pierre GASLY", team: "Alpine", acro: "GAS" },
  11: { broadcast: "S PEREZ", full: "Sergio PEREZ", team: "Cadillac", acro: "PER" },
  12: { broadcast: "K ANTONELLI", full: "Kimi ANTONELLI", team: "Mercedes", acro: "ANT" },
  14: { broadcast: "F ALONSO", full: "Fernando ALONSO", team: "Aston Martin", acro: "ALO" },
  16: { broadcast: "C LECLERC", full: "Charles LECLERC", team: "Ferrari", acro: "LEC" },
  18: { broadcast: "L STROLL", full: "Lance STROLL", team: "Aston Martin", acro: "STR" },
  23: { broadcast: "A ALBON", full: "Alexander ALBON", team: "Williams", acro: "ALB" },
  27: { broadcast: "N HULKENBERG", full: "Nico HULKENBERG", team: "Audi", acro: "HUL" },
  30: { broadcast: "L LAWSON", full: "Liam LAWSON", team: "Racing Bulls", acro: "LAW" },
  31: { broadcast: "E OCON", full: "Esteban OCON", team: "Haas F1 Team", acro: "OCO" },
  41: { broadcast: "A LINDBLAD", full: "Arvid LINDBLAD", team: "Racing Bulls", acro: "LIN" },
  43: { broadcast: "F COLAPINTO", full: "Franco COLAPINTO", team: "Alpine", acro: "COL" },
  44: { broadcast: "L HAMILTON", full: "Lewis HAMILTON", team: "Ferrari", acro: "HAM" },
  55: { broadcast: "C SAINZ", full: "Carlos SAINZ", team: "Williams", acro: "SAI" },
  63: { broadcast: "G RUSSELL", full: "George RUSSELL", team: "Mercedes", acro: "RUS" },
  77: { broadcast: "V BOTTAS", full: "Valtteri BOTTAS", team: "Cadillac", acro: "BOT" },
  81: { broadcast: "O PIASTRI", full: "Oscar PIASTRI", team: "McLaren", acro: "PIA" },
  87: { broadcast: "O BEARMAN", full: "Oliver BEARMAN", team: "Haas F1 Team", acro: "BEA" },
};

/**
 * @param {object} state
 * @param {number} driverNumber
 */
export function driverLabel(state, driverNumber) {
  const n = Number(driverNumber);
  const live = state?.drivers?.[n];
  if (live?.broadcast_name) return live.broadcast_name;
  if (live?.name_acronym) return live.name_acronym;
  if (live?.full_name) return live.full_name;
  const fb = ROSTER_2026[n];
  if (fb) return fb.broadcast || fb.acro;
  return `#${n}`;
}

/**
 * @param {object} state
 * @param {number} driverNumber
 */
export function driverTeam(state, driverNumber) {
  const n = Number(driverNumber);
  const live = state?.drivers?.[n];
  if (live?.team_name) return live.team_name;
  return ROSTER_2026[n]?.team || null;
}
