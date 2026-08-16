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
    case "stage_sep":
      return "🔥";
    case "ses1":
    case "ses2":
    case "relight":
      return "♻️";
    case "fairing":
      return "🛡️";
    case "entry_burn":
    case "entry_burn_end":
    case "entry":
      return "☄️";
    case "booster_landing":
    case "landing_burn_booster":
      return "🛬";
    case "booster_catch":
      return "🦾";
    case "booster_splash":
    case "ship_splash":
      return "🌊";
    case "deploy_start":
    case "deploy_done":
      return "📡";
    case "seco":
    case "seco2":
    case "meco":
      return "⏹️";
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
