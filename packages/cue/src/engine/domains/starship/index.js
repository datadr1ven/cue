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
  LAUNCH_ACTIONS,
  STARSHIP_ACTIONS, // deprecated alias of LAUNCH_ACTIONS
  OPS_ALWAYS_ON_IDS,
  actionByKey,
  actionById,
  formatHelp,
  formatTPlus,
  formatOpsButtonLabel,
  opsActionsForScript,
  opsInlineKeyboardRows,
} from "./actions.js";
export { tPlusSec } from "./snapshot.js";
