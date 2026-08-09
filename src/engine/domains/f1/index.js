import { createF1State, reduceF1 } from "./snapshot.js";
import { detectF1Moments } from "./moments.js";
import { renderF1Moment } from "./render.js";

export function createF1Domain() {
  return {
    createState: createF1State,
    reduce: reduceF1,
    detectMoments: detectF1Moments,
    renderMoment: renderF1Moment,
  };
}

export { ROSTER_2026, driverLabel } from "./roster.js";
