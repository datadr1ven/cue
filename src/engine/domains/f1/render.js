/**
 * Template render only (no LLM).
 */

/**
 * @param {import('../../types.js').Moment} moment
 * @param {object} state
 */
export function renderF1Moment(moment, state) {
  const d = moment.data || {};

  switch (moment.type) {
    case "session.started":
      return `🚦 Session started${d.message?.includes("Q") ? ` (${d.message})` : ""}`;

    case "quali.segment_start":
      return `🚦 ${d.label || "Qualifying"} started`;

    case "quali.session_best": {
      const prev =
        d.prevDriverName && d.prevTimeSec != null
          ? ` (was ${d.prevDriverName} ${formatLapTime(d.prevTimeSec)})`
          : "";
      return `⏱️ ${d.label ? d.label + " · " : ""}Session best: ${d.driverName} ${d.timeLabel || formatLapTime(d.timeSec)}${prev}`;
    }

    case "quali.chequered":
      return finishLine(
        `🏁 ${d.label || "Qualifying"} chequered`,
        d.top5,
      );

    case "quali.cut": {
      const out =
        d.outNames?.length > 0
          ? ` · out: ${d.outNames.slice(0, 6).join(", ")}${d.outNames.length > 6 ? "…" : ""}`
          : "";
      const thru =
        d.throughNames?.length > 0
          ? d.throughNames.slice(0, 8).join(", ") +
            (d.throughNames.length > 8 ? "…" : "")
          : "—";
      return `📋 ${d.label} over → ${d.nextLabel || "next"}\nThrough: ${thru}${out}`;
    }

    case "quali.pole": {
      const top =
        d.top3?.length > 0
          ? d.top3.map((x) => `P${x.pos} ${x.name}`).join(" · ")
          : d.poleName || "";
      return `🥇 Pole: ${d.poleName || "—"}${top ? `\n${top}` : ""}`;
    }

    case "session.finished":
      return finishLine("Session finished", d.top5);

    case "session.chequered":
      return finishLine("🏁 Chequered flag", d.top5 || formatLeader(d));

    case "flag.vsc":
      return `⚠️ VSC deployed${leaderClause(d)}`;

    case "flag.safety_car":
      return `🚨 Safety car deployed${leaderClause(d)}`;

    case "flag.red":
      return `🔴 Red flag — ${shortMsg(d.message)}`;

    case "order.leader_change":
      return `👑 New leader: ${d.driverName} (was P${d.fromPos}${
        d.prevLeaderName ? `, was ${d.prevLeaderName}` : ""
      })${top3clause(d.top3)}`;

    case "order.big_swing": {
      const dir = d.gained > 0 ? "up" : "down";
      return `📊 ${d.driverName} ${dir} P${d.fromPos}→P${d.toPos}`;
    }

    case "strategy.pit": {
      const bits = [
        `🛠️ ${d.driverName} pits`,
        d.lap != null ? `lap ${d.lap}` : null,
        d.compound ? `→ ${d.compound}` : null,
        d.position != null ? `was P${d.position}` : null,
        d.trackStatus && d.trackStatus !== "green"
          ? `under ${d.trackStatus}`
          : null,
      ].filter(Boolean);
      return bits.join(" · ");
    }

    case "penalty.time":
      return `⚖️ ${shortMsg(d.message)}`;

    case "stewards.investigation":
      return `🔍 ${shortMsg(d.message)}`;

    case "radio.clip": {
      const ctx = [
        d.driverName,
        d.position != null ? `P${d.position}` : null,
        d.trackStatus && d.trackStatus !== "green" ? d.trackStatus : null,
        d.leaderName ? `leader ${d.leaderName}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `📻 Team radio — ${ctx}${d.url ? `\n${d.url}` : ""}`;
    }

    default:
      return d.message ? shortMsg(d.message) : moment.type;
  }
}

function leaderClause(d) {
  if (d.leaderName) return ` · leader ${d.leaderName}`;
  return "";
}

function top3clause(top3) {
  if (!top3?.length) return "";
  return ` · ${top3.map((x) => `P${x.pos} ${x.name}`).join(", ")}`;
}

function finishLine(prefix, top5) {
  if (Array.isArray(top5) && top5.length) {
    const line = top5.map((x) => `P${x.pos} ${x.name}`).join(" · ");
    return `${prefix}: ${line}`;
  }
  if (typeof top5 === "string") return `${prefix}: ${top5}`;
  return prefix;
}

function formatLeader(d) {
  if (d.leaderName) return d.leaderName;
  return "";
}

function shortMsg(msg) {
  const s = String(msg || "").replace(/\s+/g, " ").trim();
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

function formatLapTime(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s)) return "?";
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m <= 0) return rem.toFixed(3);
  return `${m}:${rem.toFixed(3).padStart(6, "0")}`;
}
