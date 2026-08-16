/**
 * Template render only (no LLM).
 */

/** Shown on session / segment openers only — not every alert. */
export const TELEMETRY_DISCLAIMER_SHORT =
  "Live timing · unofficial · order can lag";

/**
 * @param {import('../../types.js').Moment} moment
 * @param {object} state
 */
export function renderF1Moment(moment, state) {
  const d = moment.data || {};
  const head = ctxPrefix(d, state);

  switch (moment.type) {
    case "session.started": {
      const what = d.label || (d.practice ? "Practice" : "Session");
      return withHead(
        head,
        withDisclaimer(`🚦 ${what} started`),
      );
    }

    case "quali.segment_start":
      return withHead(
        head,
        withDisclaimer(`🚦 ${d.label || "Qualifying"} started`),
      );

    case "quali.session_best": {
      // Time loop is source of truth; timing board / position can lag
      const prev =
        d.prevDriverName && d.prevTimeSec != null
          ? ` (was ${d.prevDriverName} ${formatLapTime(d.prevTimeSec)})`
          : "";
      const tyre =
        d.compound && String(d.compound).toUpperCase() !== "SOFT"
          ? ` · ${d.compound}`
          : "";
      // Position feed often trails the timing loop (especially early / out-laps).
      // Only annotate when the driver is "on the board" in a useful way.
      let board = "";
      if (d.boardPos != null && d.boardPos >= 1 && d.boardPos <= 10) {
        board = ` · board P${d.boardPos}`;
        if (
          d.boardPos !== 1 &&
          d.boardLeaderName &&
          d.boardLeaderName !== d.driverName
        ) {
          // Short cross-check only — full disclaimer is on session start
          board += ` (board P1: ${d.boardLeaderName})`;
        }
      }
      return withHead(
        head,
        `⏱️ Fastest lap: ${d.driverName} ${d.timeLabel || formatLapTime(d.timeSec)}${prev}${tyre}${board}`,
      );
    }

    case "quali.chequered":
      return withHead(
        head,
        finishLine(`🏁 ${d.label || "Qualifying"} chequered`, d.top5),
      );

    case "quali.cut": {
      // Emphasize who is out — the drama of the cut line
      const outNames = d.outNames || [];
      const outLine =
        outNames.length > 0
          ? outNames.slice(0, 8).join(", ") +
            (outNames.length > 8 ? "…" : "")
          : "—";
      const nOut = d.outCount ?? outNames.length;
      const nThru = d.throughCount ?? d.throughNames?.length;
      const thruHint =
        nThru != null
          ? ` · ${nThru} through to ${d.nextLabel || "next"}`
          : d.nextLabel
            ? ` · rest → ${d.nextLabel}`
            : "";
      return withHead(
        head,
        `📋 ${d.label} over — out (${nOut || outNames.length}):\n${outLine}${thruHint}`,
      );
    }

    case "quali.pole": {
      const top =
        d.top3?.length > 0
          ? d.top3.map((x) => `P${x.pos} ${x.name}`).join(" · ")
          : d.poleName || "";
      const title = d.sprintShootout
        ? `🥇 Sprint pole: ${d.poleName || "—"}`
        : `🥇 Pole: ${d.poleName || "—"}`;
      return withHead(head, `${title}${top ? `\n${top}` : ""}`);
    }

    case "session.finished":
      return withHead(head, finishLine("Session finished", d.top5));

    case "session.chequered": {
      if (d.practice) {
        const best =
          d.sessionBestName && d.sessionBestTime
            ? `\nFastest: ${d.sessionBestName} ${d.sessionBestTime}`
            : "";
        return withHead(
          head,
          `🏁 ${d.label || "Practice"} finished${best}`,
        );
      }
      return withHead(
        head,
        finishLine(
          d.label ? `🏁 ${d.label} · chequered` : "🏁 Chequered flag",
          d.top5 || formatLeader(d),
        ),
      );
    }

    case "flag.vsc":
      return withHead(head, `⚠️ VSC deployed${leaderClause(d)}`);

    case "flag.safety_car":
      return withHead(head, `🚨 Safety car deployed${leaderClause(d)}`);

    case "flag.red":
      return withHead(head, `🔴 Red flag — ${shortMsg(d.message)}`);

    case "order.leader_change":
      return withHead(
        head,
        `👑 New leader: ${d.driverName} (was P${d.fromPos}${
          d.prevLeaderName ? `, was ${d.prevLeaderName}` : ""
        })${top3clause(d.top3)}`,
      );

    case "order.big_swing": {
      const dir = d.gained > 0 ? "up" : "down";
      return withHead(
        head,
        `📊 ${d.driverName} ${dir} P${d.fromPos}→P${d.toPos}`,
      );
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
      return withHead(head, bits.join(" · "));
    }

    case "penalty.time":
      return withHead(head, `⚖️ ${shortMsg(d.message)}`);

    case "stewards.investigation":
      return withHead(head, `🔍 ${shortMsg(d.message)}`);

    case "radio.clip": {
      const ctx = [
        d.driverName,
        d.position != null ? `P${d.position}` : null,
        d.compound && String(d.compound).toUpperCase() !== "SOFT"
          ? d.compound
          : null,
        d.trackStatus && d.trackStatus !== "green" ? d.trackStatus : null,
        d.leaderName ? `leader ${d.leaderName}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return withHead(
        head,
        `📻 Team radio — ${ctx}${d.url ? `\n${d.url}` : ""}`,
      );
    }

    default:
      return withHead(
        head,
        d.message ? shortMsg(d.message) : moment.type,
      );
  }
}

function ctxPrefix(d, state) {
  if (d.context) return d.context;
  const bits = [];
  if (state?.meetingName) bits.push(state.meetingName);
  if (d.label) bits.push(d.label);
  return bits.join(" · ") || "";
}

function withHead(head, body) {
  if (!head) return body;
  // Avoid "Chinese GP · Q1 · 🚦 Q1 started" doubling when body already has label
  if (body.includes(head)) return body;
  return `${head}\n${body}`;
}

function withDisclaimer(body) {
  return `${body}\n${TELEMETRY_DISCLAIMER_SHORT}`;
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
