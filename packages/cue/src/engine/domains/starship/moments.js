/**
 * Almost 1:1 operator action → moment (HITL).
 */

/**
 * @param {object} prev
 * @param {object} next
 * @param {import('../../../types.js').IngestEvent} event
 */
export function detectStarshipMoments(prev, next, event) {
  if (event.type !== "starship.action") return [];
  const p = event.payload || {};
  if (!p.actionId) return [];

  return [
    {
      id: `${p.actionId}-${event.t}`,
      type: `starship.${p.actionId}`,
      severity: Number(p.severity) || 7,
      t: event.t,
      data: {
        actionId: p.actionId,
        label: p.label,
        phase: p.phase || next.phase,
        tPlusSec: p.tPlusSec,
        scriptTPlusSec: p.scriptTPlusSec,
        missionName: next.missionName,
      },
    },
  ];
}
