/**
 * In-bundle mission catalog (no filesystem).
 * Used by Cloudflare Workers and offline tools that import JSON.
 */

import index from "../../missions/index.json" with { type: "json" };
import flight12 from "../../missions/flights/starship-flight-12-script.json" with { type: "json" };
import flight13 from "../../missions/flights/starship-flight-13-script.json" with { type: "json" };
import starlink1750 from "../../missions/flights/starlink-sl-17-50-script.json" with { type: "json" };
import starlink1523 from "../../missions/flights/starlink-sl-15-23-script.json" with { type: "json" };
import romanFh from "../../missions/flights/roman-fh-script.json" with { type: "json" };

const DOCS = {
  [starlink1523.missionId]: starlink1523,
  [romanFh.missionId]: romanFh,
  [flight12.missionId]: flight12,
  [flight13.missionId]: flight13,
  [starlink1750.missionId]: starlink1750,
};

/**
 * Map index file path → doc (by matching missions/index entries).
 */
function docForEntry(entry) {
  if (!entry) return null;
  if (DOCS[entry.id]) return DOCS[entry.id];
  // fallback: match by number in id
  for (const doc of Object.values(DOCS)) {
    if (entry.number != null && doc.missionId?.endsWith(`-${entry.number}`)) {
      return doc;
    }
  }
  return null;
}

export function bundledListMissions() {
  return (index.missions || []).map((m) => ({
    ...m,
    isDefault: m.id === index.defaultMissionId,
  }));
}

export function bundledResolveRef(ref) {
  const missions = index.missions || [];
  if (ref == null || ref === "" || ref === "default" || ref === "latest") {
    const id = index.defaultMissionId || missions.at(-1)?.id;
    return missions.find((m) => m.id === id) || null;
  }
  const s = String(ref).trim();
  const asNum = Number(s);
  if (Number.isFinite(asNum) && String(asNum) === s) {
    return missions.find((m) => m.number === asNum) || null;
  }
  return (
    missions.find((m) => m.id === s) ||
    missions.find((m) => m.id.endsWith(`-${s}`)) ||
    null
  );
}

export function bundledLoadMission(ref) {
  const entry = bundledResolveRef(ref);
  if (!entry) return null;
  const doc = docForEntry(entry);
  if (!doc) return null;
  return { entry, path: `bundle:${entry.id}`, doc };
}

export { formatEta as bundledFormatEta } from "./script-utils.js";
export { index as bundledIndex, DOCS as bundledDocs };
