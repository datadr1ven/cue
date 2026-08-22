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
      // Time loop is source of truth — no position-board jargon
      const prev =
        d.prevDriverName && d.prevTimeSec != null
          ? ` (was ${d.prevDriverName} ${formatLapTime(d.prevTimeSec)})`
          : "";
      const tyre =
        d.compound && String(d.compound).toUpperCase() !== "SOFT"
          ? ` · ${d.compound}`
          : "";
      const late = d.afterChequered ? " · after chequered" : "";
      return withHead(
        head,
        `⏱️ Fastest lap: ${d.driverName} ${d.timeLabel || formatLapTime(d.timeSec)}${prev}${tyre}${late}`,
      );
    }

    case "quali.chequered":
      return withHead(
        head,
        finishLine(`🏁 ${d.label || "Qualifying"} chequered`, d.top5) +
          "\n(cars already on a lap can still improve)",
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
      const kind = d.sprintShootout ? "Sprint pole" : "Pole";
      const title = d.provisional
        ? `🥇 Provisional ${kind.toLowerCase()}: ${d.poleName || "—"}`
        : `🥇 ${kind}: ${d.poleName || "—"}`;
      const note = d.provisional
        ? "\n(cars already on a lap can still improve)"
        : "";
      return withHead(head, `${title}${top ? `\n${top}` : ""}${note}`);
    }

    case "quali.pole_change": {
      const was = d.prevPoleName ? ` (was ${d.prevPoleName})` : "";
      const kind = d.sprintShootout ? "sprint pole" : "pole";
      const top =
        d.top3?.length > 0
          ? "\n" + d.top3.map((x) => `P${x.pos} ${x.name}`).join(" · ")
          : "";
      return withHead(
        head,
        `🥇 Provisional ${kind}: ${d.poleName || "—"}${was}${top}\n(cars already on a lap can still improve)`,
      );
    }

    case "quali.into_cut":
      return withHead(
        head,
        `📈 ${d.driverName || "Driver"} into the ${d.label || "Q"} cut · P${d.fromPos}→P${d.toPos}`,
      );

    case "quali.prov_p1": {
      const kind = d.sprintShootout ? "sprint pole" : "pole";
      const top =
        d.top3?.length > 0
          ? "\n" +
            d.top3
              .map(
                (x) =>
                  `P${x.pos} ${x.name}${x.timeSec != null ? ` ${formatLapTime(x.timeSec)}` : ""}`,
              )
              .join(" · ")
          : "";
      if (d.cleanedUp) {
        const prevT =
          d.prevTimeSec != null ? ` (was ${formatLapTime(d.prevTimeSec)})` : "";
        return withHead(
          head,
          `🥇 Provisional ${kind} time: ${d.driverName || "—"}${prevT}\n${d.timeLabel || formatLapTime(d.timeSec)}${top}`,
        );
      }
      const jump =
        d.jumped != null && d.jumped > 0
          ? ` (was P${d.fromRank}, ↑${d.jumped})`
          : d.fromRank != null
            ? ` (was P${d.fromRank})`
            : "";
      const was = d.prevLeaderName ? ` · was ${d.prevLeaderName}` : "";
      return withHead(
        head,
        `🥇 Provisional ${kind}: ${d.driverName || "—"}${jump}${was}\n${d.timeLabel || formatLapTime(d.timeSec)}${top}`,
      );
    }

    case "quali.close_to_pole": {
      const gap =
        d.gapToLeader != null ? ` · +${Number(d.gapToLeader).toFixed(3)}s` : "";
      const lead = d.leaderName ? ` to ${d.leaderName}` : "";
      return withHead(
        head,
        `🤏 ${d.driverName || "Driver"} P${d.toRank}${gap}${lead} · ${d.timeLabel || formatLapTime(d.timeSec)} (close, no ${d.sprintShootout ? "sprint " : ""}pole)`,
      );
    }

    case "weather.rain_risk":
      return withHead(
        head,
        `🌧️ ${String(d.message || "Rain risk").replace(/\s+/g, " ").trim()}`,
      );

    case "weather.rain":
      return withHead(head, "🌧️ Rain detected at the circuit");

    case "session.finished":
      return withHead(head, raceFinishLine("Session finished", d));

    case "session.chequered": {
      if (d.practice) {
        const lines = [`🏁 ${d.label || "Practice"} finished`];
        if (d.sessionBestName && d.sessionBestTime) {
          lines.push(`Fastest: ${d.sessionBestName} ${d.sessionBestTime}`);
        }
        if (Array.isArray(d.compounds) && d.compounds.length > 0) {
          lines.push(`Compounds: ${d.compounds.join(", ")}`);
        }
        if (
          d.mostStopsCount > 0 &&
          Array.isArray(d.mostStopsNames) &&
          d.mostStopsNames.length > 0
        ) {
          const who = d.mostStopsNames.slice(0, 3).join(", ");
          const more =
            d.mostStopsNames.length > 3
              ? ` +${d.mostStopsNames.length - 3}`
              : "";
          lines.push(`Most stops: ${who}${more} (${d.mostStopsCount})`);
        }
        return withHead(head, lines.join("\n"));
      }
      let title = d.label
        ? `🏁 ${d.label} · chequered`
        : "🏁 Chequered flag";
      if (d.underSafetyCar) title += " · under safety car";
      else if (d.underVsc) title += " · under VSC";
      return withHead(head, raceFinishLine(title, d));
    }

    case "flag.vsc":
      return withHead(head, `⚠️ VSC deployed${leaderClause(d)}`);

    case "flag.safety_car":
      return withHead(head, `🚨 Safety car deployed${leaderClause(d)}`);

    case "flag.sc_unlap": {
      const n = Array.isArray(d.cars) ? d.cars.length : 0;
      const who =
        n > 0 ? `${n} car${n === 1 ? "" : "s"}` : "lapped cars";
      return withHead(
        head,
        `↩️ ${who} may overtake the safety car${leaderClause(d)}`,
      );
    }

    case "flag.red":
      return withHead(head, `🔴 Red flag — ${shortMsg(d.message)}`);

    case "retirement": {
      const bits = [
        `💥 ${d.driverName || "Driver"} out`,
        d.position != null ? `was P${d.position}` : null,
        d.lap != null ? `lap ${d.lap}` : null,
        d.cause === "safety_car"
          ? "→ safety car"
          : d.cause === "vsc"
            ? "→ VSC"
            : d.cause === "red"
              ? "→ red flag"
              : d.source === "session_result"
                ? "DNF"
                : null,
      ].filter(Boolean);
      return withHead(head, bits.join(" · "));
    }

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

    case "order.snapshot": {
      const line =
        Array.isArray(d.top5) && d.top5.length
          ? d.top5.map((x) => `P${x.pos} ${x.name}`).join(" · ")
          : "—";
      return withHead(head, `📋 Order (approx): ${line}`);
    }

    case "strategy.pit": {
      // Prefer single line after short wait for stint feed; timeout → off only
      let tyre = null;
      if (d.compoundOff && d.compoundOn) {
        tyre =
          d.compoundOff === d.compoundOn
            ? `fresh ${d.compoundOn}`
            : `${d.compoundOff} → ${d.compoundOn}`;
      } else if (d.compoundOn) {
        tyre = `→ ${d.compoundOn}`;
      } else if (d.compoundOff) {
        tyre = `off ${d.compoundOff}`;
      }
      const bits = [
        `🛠️ ${d.driverName || "Driver"} pits`,
        d.lap != null ? `lap ${d.lap}` : null,
        tyre,
        d.positionIn != null ? `from P${d.positionIn}` : null,
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

/**
 * Race finish: official-looking board, or provisional from lap times.
 * @param {string} prefix
 * @param {object} d
 */
function raceFinishLine(prefix, d) {
  let p = prefix;
  // session.finished path also benefits from under-SC framing
  if (!/under safety car|under VSC/.test(p)) {
    if (d.underSafetyCar) p += " · under safety car";
    else if (d.underVsc) p += " · under VSC";
  }
  const top5 = d.top5;
  if (!Array.isArray(top5) || !top5.length) {
    return p;
  }
  if (d.provisional && d.orderSource === "laps") {
    const line = top5.map((x) => x.name).join(" · ");
    const win = d.winnerName ? `Winner (provisional): ${d.winnerName}\n` : "";
    return `${p}\n${win}${line}\n(from lap times · board incomplete)`;
  }
  if (d.provisional) {
    return `${finishLine(`${p} (approx)`, top5)}`;
  }
  return finishLine(p, top5);
}

function formatLeader(d) {
  if (d.leaderName) return d.leaderName;
  return "";
}

function shortMsg(msg, maxLen = 300) {
  const s = String(msg || "").replace(/\s+/g, " ").trim();
  const cap = Math.max(40, Number(maxLen) || 300);
  return s.length > cap ? s.slice(0, cap - 1) + "…" : s;
}

function formatLapTime(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s)) return "?";
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m <= 0) return rem.toFixed(3);
  return `${m}:${rem.toFixed(3).padStart(6, "0")}`;
}
