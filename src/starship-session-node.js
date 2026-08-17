/**
 * Node entry: launch session with filesystem mission registry.
 */

import { createStarshipSession as createCore } from "./starship-session.js";
import {
  loadMission,
  loadMissionFromPath,
  listMissions,
  formatEta,
  getMissionsRoot,
  MISSIONS_ROOT,
} from "./missions/registry.js";

/**
 * @param {object} [opts]
 * @param {string|number} [opts.missionRef]
 * @param {string} [opts.scriptPath]
 * @param {number} [opts.minSeverity]
 * @param {(alert: object, state: object) => void|Promise<void>} [opts.onAlert]
 */
export function createStarshipSession(opts = {}) {
  const root = getMissionsRoot() || MISSIONS_ROOT;

  if (opts.scriptPath) {
    const fixed = loadMissionFromPath(opts.scriptPath);
    return createCore({
      ...opts,
      missionRef: "default",
      loader: {
        loadMission: (ref) => {
          if (
            ref == null ||
            ref === "" ||
            ref === "default" ||
            ref === fixed.doc.missionId
          ) {
            return fixed;
          }
          return loadMission(ref, root);
        },
        listMissions: () => listMissions(root),
        formatEta,
      },
    });
  }

  return createCore({
    ...opts,
    loader: {
      loadMission: (ref) => loadMission(ref, root),
      listMissions: () => listMissions(root),
      formatEta,
    },
  });
}
