import { createStarshipState, reduceStarship } from "./snapshot.js";
import { detectStarshipMoments } from "./moments.js";
import { renderStarshipMoment } from "./render.js";

export function createStarshipDomain() {
  return {
    createState: createStarshipState,
    reduce: reduceStarship,
    detectMoments: detectStarshipMoments,
    renderMoment: renderStarshipMoment,
  };
}

export {
  STARSHIP_ACTIONS,
  actionByKey,
  actionById,
  formatHelp,
  formatTPlus,
} from "./actions.js";
export { tPlusSec } from "./snapshot.js";
