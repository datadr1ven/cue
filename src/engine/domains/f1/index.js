import {
  createF1State,
  reduceF1,
  normalizeSessionKind,
} from "./snapshot.js";
import { detectF1Moments } from "./moments.js";
import { renderF1Moment } from "./render.js";

/**
 * @param {import('../../types.js').EngineConfig} [config]
 */
export function createF1Domain(config = {}) {
  const kind = normalizeSessionKind(config.sessionKind);

  return {
    createState: () => {
      const s = createF1State();
      if (kind) {
        s.sessionKindForced = kind;
        s.sessionKind = kind;
      }
      return s;
    },
    reduce: (state, event) =>
      reduceF1(state, event, kind ? { sessionKind: kind } : {}),
    detectMoments: detectF1Moments,
    renderMoment: renderF1Moment,
  };
}

export { ROSTER_2026, driverLabel } from "./roster.js";
export {
  isQualifyingMode,
  isRaceStyleMode,
  isPracticeMode,
  isKnockoutMode,
  normalizeSessionKind,
  SESSION_KINDS,
} from "./snapshot.js";
