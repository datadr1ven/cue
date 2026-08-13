/**
 * Shared Starship HITL session: mission load + action / note inject.
 */

import { createPipeline } from "./engine/pipeline.js";
import {
  actionById,
  formatTPlus,
  tPlusSec,
} from "./engine/domains/starship/index.js";
import {
  loadMission,
  loadMissionFromPath,
  listMissions,
  scriptTPlusMap,
  formatEta,
  MISSIONS_ROOT,
} from "./missions/registry.js";

/**
 * @param {object} [opts]
 * @param {string|number} [opts.missionRef] - id, number, or default
 * @param {string} [opts.scriptPath] - absolute/relative path (overrides registry)
 * @param {number} [opts.minSeverity]
 * @param {(alert: object, state: object) => void|Promise<void>} [opts.onAlert]
 */
export function createStarshipSession(opts = {}) {
  const pipeline = createPipeline({
    domain: "starship",
    source: "manual",
    useLlm: false,
    usePrefs: false,
    minSeverity: opts.minSeverity ?? 1,
    dedupeMs: 0,
  });

  let scriptDoc = null;
  let missionEntry = null;
  let missionPath = null;
  /** @type {Map<string, number>} */
  let tPlusByAction = new Map();

  function applyMission(loaded) {
    if (!loaded) return false;
    scriptDoc = loaded.doc;
    missionEntry = loaded.entry;
    missionPath = loaded.path;
    tPlusByAction = scriptTPlusMap(scriptDoc);
    // reset flight clock when switching missions
    pipeline.reset();
    pipeline.push({
      type: "starship.mission",
      t: new Date().toISOString(),
      source: "script",
      payload: {
        missionId: scriptDoc.missionId,
        missionName: scriptDoc.missionName,
        script: scriptDoc.script,
        launchApproxUtc: scriptDoc.launchApproxUtc,
      },
    });
    return true;
  }

  if (opts.scriptPath) {
    applyMission(loadMissionFromPath(opts.scriptPath));
  } else {
    applyMission(loadMission(opts.missionRef ?? "default", MISSIONS_ROOT));
  }

  /**
   * @param {string|number} ref
   */
  function loadMissionRef(ref) {
    const loaded = loadMission(ref, MISSIONS_ROOT);
    if (!loaded) return { ok: false, error: `unknown mission: ${ref}` };
    applyMission(loaded);
    return { ok: true, entry: missionEntry, doc: scriptDoc };
  }

  async function emit(event) {
    const { alerts, state } = pipeline.push(event);
    for (const alert of alerts) {
      if (opts.onAlert) await opts.onAlert(alert, state);
    }
    return { alerts, state };
  }

  /**
   * @param {string} actionId
   * @param {object} [extra]
   */
  async function fire(actionId, extra = {}) {
    const action = actionById(actionId);
    if (!action) {
      return { ok: false, error: `unknown action ${actionId}` };
    }

    const wallMs = Date.now();
    const stateBefore = pipeline.getState();
    let tPlus = tPlusSec(stateBefore, wallMs);
    if (actionId === "liftoff") tPlus = 0;

    const scriptT =
      tPlusByAction.has(actionId)
        ? tPlusByAction.get(actionId)
        : action.scriptTPlusSec;

    const event = {
      type: "starship.action",
      t: new Date(wallMs).toISOString(),
      source: "manual",
      payload: {
        actionId: action.id,
        label: action.label,
        phase: action.phase,
        severity: action.severity,
        scriptTPlusSec: scriptT ?? null,
        tPlusSec: tPlus,
        wallMs,
        ...extra,
      },
    };

    const { alerts, state } = await emit(event);
    return {
      ok: true,
      action: { ...action, scriptTPlusSec: scriptT ?? null },
      alerts,
      state,
      tPlusSec: tPlus,
    };
  }

  /**
   * Freeform note → all subscribers (same stream).
   * @param {string} text
   * @param {object} [opts2]
   * @param {number} [opts2.severity]
   */
  async function fireNote(text, opts2 = {}) {
    const label = String(text || "").trim();
    if (!label) return { ok: false, error: "empty note" };
    const wallMs = Date.now();
    const stateBefore = pipeline.getState();
    const tPlus = tPlusSec(stateBefore, wallMs);
    const event = {
      type: "starship.action",
      t: new Date(wallMs).toISOString(),
      source: "manual",
      payload: {
        actionId: "note",
        label,
        phase: stateBefore.phase || "note",
        severity: opts2.severity ?? 7,
        tPlusSec: tPlus,
        wallMs,
        freeform: true,
      },
    };
    const { alerts, state } = await emit(event);
    return { ok: true, alerts, state, tPlusSec: tPlus };
  }

  /**
   * Announcement (same fan-out; distinct render).
   * @param {string} text
   */
  async function fireBroadcast(text) {
    const label = String(text || "").trim();
    if (!label) return { ok: false, error: "empty broadcast" };
    const wallMs = Date.now();
    const event = {
      type: "starship.action",
      t: new Date(wallMs).toISOString(),
      source: "manual",
      payload: {
        actionId: "broadcast",
        label,
        phase: "announce",
        severity: 7,
        tPlusSec: null,
        wallMs,
        freeform: true,
      },
    };
    const { alerts, state } = await emit(event);
    return { ok: true, alerts, state };
  }

  /**
   * HITL hype template from launchApproxUtc.
   * @param {number} hours - e.g. 48, 24, 1
   */
  async function fireHype(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      return { ok: false, error: "hype hours must be a positive number" };
    }
    const name = scriptDoc?.missionName || "Next flight";
    const net = scriptDoc?.launchApproxUtc;
    const eta = formatEta(net);
    const window =
      h >= 48 ? "about 2 days" : h >= 24 ? "about 1 day" : `about ${h}h`;
    const label = net
      ? `${name} is ${window} out (NET ${net}). ${eta.ok ? eta.text : ""}`.trim()
      : `${name}: launch window ~${window} out (set launchApproxUtc for exact NET).`;
    const wallMs = Date.now();
    const event = {
      type: "starship.action",
      t: new Date(wallMs).toISOString(),
      source: "manual",
      payload: {
        actionId: "hype",
        label,
        phase: "window",
        severity: 6,
        tPlusSec: null,
        wallMs,
        hypeHours: h,
        freeform: true,
      },
    };
    const { alerts, state } = await emit(event);
    return { ok: true, alerts, state, label };
  }

  function status() {
    const state = pipeline.getState();
    const tp = tPlusSec(state);
    const eta = formatEta(scriptDoc?.launchApproxUtc);
    return {
      missionId: scriptDoc?.missionId || null,
      missionName: scriptDoc?.missionName || null,
      missionNumber: missionEntry?.number ?? null,
      phase: state.phase,
      tPlusSec: tp,
      tPlusLabel: tp == null ? "pre-liftoff" : `T+${formatTPlus(tp)}`,
      liftoffSet: state.liftoffWallMs != null,
      lastActionId: state.lastActionId,
      history: state.history,
      launchApproxUtc: scriptDoc?.launchApproxUtc || null,
      etaText: eta.text,
      path: missionPath,
    };
  }

  /**
   * Human-readable timeline for archive browse.
   * @param {string|number} [ref] - default active
   */
  function formatTimeline(ref) {
    const loaded =
      ref == null || ref === ""
        ? { doc: scriptDoc, entry: missionEntry }
        : loadMission(ref, MISSIONS_ROOT);
    if (!loaded?.doc) return "Mission not found.";
    const doc = loaded.doc;
    const lines = [
      doc.missionName || doc.missionId,
      doc.source ? `Source: ${doc.source}` : null,
      doc.launchApproxUtc ? `NET: ${doc.launchApproxUtc}` : null,
      "",
      "Nominal T+ (script):",
    ].filter((x) => x != null);
    for (const row of doc.script || []) {
      const t =
        row.tPlusSec == null ? "—" : formatTPlus(Number(row.tPlusSec));
      lines.push(`  T+${t}  ${row.label || row.actionId}`);
    }
    return lines.join("\n");
  }

  function formatMissionList() {
    const rows = listMissions(MISSIONS_ROOT);
    return rows
      .map(
        (m) =>
          `${m.isDefault ? "*" : " "} ${m.number ?? "—"}  ${m.label || m.id}`,
      )
      .join("\n");
  }

  return {
    pipeline,
    get scriptDoc() {
      return scriptDoc;
    },
    get missionEntry() {
      return missionEntry;
    },
    fire,
    fireNote,
    fireBroadcast,
    fireHype,
    status,
    loadMission: loadMissionRef,
    formatTimeline,
    formatMissionList,
    formatEta: () => formatEta(scriptDoc?.launchApproxUtc),
    reset: () => {
      const ref = missionEntry?.id || scriptDoc?.missionId;
      pipeline.reset();
      if (ref) loadMissionRef(ref);
    },
  };
}
