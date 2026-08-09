import { formatTPlus } from "./actions.js";

/**
 * @param {import('../../../types.js').Moment} moment
 */
export function renderStarshipMoment(moment) {
  const d = moment.data || {};
  const tPlus =
    d.tPlusSec != null ? `T+${formatTPlus(d.tPlusSec)}` : "T+—";
  const mission = d.missionName ? `${d.missionName} · ` : "";
  const label = d.label || d.actionId || moment.type;

  const emoji = emojiFor(d.actionId);
  return `${emoji} ${mission}${tPlus} — ${label}`;
}

function emojiFor(id) {
  switch (id) {
    case "liftoff":
      return "🚀";
    case "hot_stage":
      return "🔥";
    case "booster_catch":
      return "🦾";
    case "booster_splash":
    case "ship_splash":
      return "🌊";
    case "deploy_start":
    case "deploy_done":
      return "📡";
    case "relight":
      return "♻️";
    case "entry":
      return "☄️";
    case "los":
      return "📡❌";
    case "anomaly":
      return "💥";
    case "success":
      return "✅";
    case "hold":
      return "🛑";
    case "go":
      return "🟢";
    default:
      return "⭐";
  }
}
