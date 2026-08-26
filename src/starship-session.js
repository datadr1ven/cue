/**
 * Launch HITL session (runtime-agnostic) — Starship, Falcon, Starlink, …
 * Requires opts.loader — on Node use createStarshipSession from starship-session-node.js
 */

import { createPipeline } from "./engine/pipeline.js";
import {
  actionById,
  formatTPlus,
  tPlusSec,
} from "./engine/domains/starship/index.js";
import { scriptTPlusMap, formatEta as defaultFormatEta } from "./missions/script-utils.js";

/**
 * @param {object} opts
 * @param {{ loadMission: Function, listMissions: Function, formatEta?: Function }} opts.loader
 * @param {string|number} [opts.missionRef]
 * @param {number} [opts.minSeverity]
 * @param {(alert: object, state: object) => void|Promise<void>} [opts.onAlert]
 */
export function createStarshipSession(opts = {}) {
  if (!opts.loader?.loadMission || !opts.loader?.listMissions) {
    throw new Error(
      "createStarshipSession requires opts.loader { loadMission, listMissions }",
    );
  }

  const loadMissionFn = opts.loader.loadMission;
  const listMissionsFn = opts.loader.listMissions;
  const formatEtaFn = opts.loader.formatEta || defaultFormatEta;

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

  applyMission(loadMissionFn(opts.missionRef ?? "default"));

  function loadMissionRef(ref) {
    const loaded = loadMissionFn(ref);
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

  async function fire(actionId, extra = {}) {
    const action = actionById(actionId);
    if (!action) {
      return { ok: false, error: `unknown action ${actionId}` };
    }

    const wallMs = Date.now();
    const stateBefore = pipeline.getState();
    let tPlus = tPlusSec(stateBefore, wallMs);
    if (actionId === "liftoff") tPlus = 0;

    const scriptT = tPlusByAction.has(actionId)
      ? tPlusByAction.get(actionId)
      : action.scriptTPlusSec;
    // Prefer mission script wording when present
    const scriptRow = Array.isArray(scriptDoc?.script)
      ? scriptDoc.script.find((r) => r.actionId === actionId)
      : null;
    const label = scriptRow?.label || action.label;

    const event = {
      type: "starship.action",
      t: new Date(wallMs).toISOString(),
      source: "manual",
      payload: {
        actionId: action.id,
        label,
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

  async function fireHype(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      return { ok: false, error: "hype hours must be a positive number" };
    }
    const name = scriptDoc?.missionName || "Next flight";
    const net = scriptDoc?.launchApproxUtc;
    const eta = formatEtaFn(net, Date.now(), { missionName: name });

    // Don't hype a long-past mission as "2 days out"
    if (eta.kind === "past" || eta.kind === "unknown" || eta.kind === "invalid") {
      return {
        ok: false,
        error:
          eta.kind === "past"
            ? "Active mission already flew — switch to the next flight or set a future NET before hyping."
            : "No upcoming NET on the active mission — set launchApproxUtc or switch mission first.",
      };
    }
    if (eta.kind === "recent") {
      return {
        ok: false,
        error: "NET window already passed for the active mission.",
      };
    }

    const window =
      h >= 48 ? "about 2 days" : h >= 24 ? "about 1 day" : `about ${h}h`;
    const label = `${name} is ${window} out · ${eta.text}`;
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
    const name = scriptDoc?.missionName || null;
    const eta = formatEtaFn(scriptDoc?.launchApproxUtc, Date.now(), {
      missionName: name,
    });
    // During a live countdown after liftoff, prefer T+ over stale NET noise
    const showEta =
      !state.liftoffWallMs ||
      eta.kind === "upcoming" ||
      eta.kind === "unknown";
    return {
      missionId: scriptDoc?.missionId || null,
      missionName: name,
      missionNumber: missionEntry?.number ?? null,
      phase: state.phase,
      tPlusSec: tp,
      tPlusLabel: tp == null ? "pre-liftoff" : `T+${formatTPlus(tp)}`,
      liftoffSet: state.liftoffWallMs != null,
      lastActionId: state.lastActionId,
      history: state.history,
      launchApproxUtc: scriptDoc?.launchApproxUtc || null,
      etaKind: eta.kind,
      etaText: eta.text,
      /** For /status: omit long-past NET spam when T+ is live */
      statusEtaLine: showEta ? eta.text : null,
      path: missionPath,
    };
  }

  function formatTimeline(ref) {
    const loaded =
      ref == null || ref === ""
        ? { doc: scriptDoc, entry: missionEntry }
        : loadMissionFn(ref);
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
      const t = row.tPlusSec == null ? "—" : formatTPlus(Number(row.tPlusSec));
      lines.push(`  T+${t}  ${row.label || row.actionId}`);
    }
    return lines.join("\n");
  }

  function formatMissionList() {
    return listMissionsFn()
      .map((m) => {
        const mark = m.isDefault ? "*" : " ";
        const num =
          m.number != null && Number.isFinite(Number(m.number))
            ? String(m.number)
            : null;
        // Always show id so /mission <id> works when there is no flight number
        const ref = num != null ? `${num} · ${m.id}` : m.id;
        return `${mark} ${ref}  ${m.label || m.id}`;
      })
      .join("\n");
  }

  function exportState() {
    const st = pipeline.getState();
    return {
      missionId: scriptDoc?.missionId || null,
      liftoffWallMs: st.liftoffWallMs,
      phase: st.phase,
      lastActionId: st.lastActionId,
      history: st.history || [],
    };
  }

  function hydrate(saved) {
    if (!saved) return;
    if (saved.missionId) loadMissionRef(saved.missionId);
    const st = pipeline.getState();
    pipeline.replaceState({
      ...st,
      liftoffWallMs: saved.liftoffWallMs ?? st.liftoffWallMs,
      phase: saved.phase || st.phase,
      lastActionId: saved.lastActionId ?? st.lastActionId,
      history: Array.isArray(saved.history) ? saved.history : st.history,
    });
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
    formatEta: () => formatEtaFn(scriptDoc?.launchApproxUtc),
    exportState,
    hydrate,
    reset: () => {
      const ref = missionEntry?.id || scriptDoc?.missionId;
      pipeline.reset();
      if (ref) loadMissionRef(ref);
    },
  };
}
