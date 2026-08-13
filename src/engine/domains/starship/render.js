import { formatTPlus } from "./actions.js";

/**
 * @param {import('../../../types.js').Moment} moment
 */
export function renderStarshipMoment(moment) {
  const d = moment.data || {};
  const label = d.label || d.actionId || moment.type;
  const mission = d.missionName ? `${d.missionName}` : null;
  const id = d.actionId;

  if (id === "broadcast") {
    return `📢 ${label}`;
  }
  if (id === "hype") {
    return `📣 ${label}`;
  }
  if (id === "note") {
    const tPlus =
      d.tPlusSec != null ? `T+${formatTPlus(d.tPlusSec)}` : null;
    const head = [mission, tPlus].filter(Boolean).join(" · ");
    return head ? `📝 ${head} — ${label}` : `📝 ${label}`;
  }

  const tPlus =
    d.tPlusSec != null ? `T+${formatTPlus(d.tPlusSec)}` : "T+—";
  const prefix = mission ? `${mission} · ` : "";
  const emoji = emojiFor(id);
  return `${emoji} ${prefix}${tPlus} — ${label}`;
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
