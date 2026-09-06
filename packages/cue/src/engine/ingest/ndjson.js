/**
 * Read capture NDJSON and yield normalized IngestEvents.
 *
 * OpenF1 (default) or SignalR (`opts.mode === 'signalr'` / source f1-signalr).
 */

import { createReadStream } from "fs";
import readline from "readline";
import { expandOpenF1Line } from "./openf1.js";
import {
  createSignalRMergeState,
  expandSignalRLine,
} from "./signalr.js";

/**
 * @param {string} filePath
 * @param {object} [opts]
 * @param {'openf1'|'signalr'|'auto'} [opts.mode='auto']
 * @returns {AsyncGenerator<import('../types.js').IngestEvent>}
 */
export async function* readNdjsonEvents(filePath, opts = {}) {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let mode = opts.mode || "auto";
  const signalrMerge = createSignalRMergeState();
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      if (opts.strict) throw new Error(`Invalid JSON at line ${lineNo}`);
      continue;
    }
    if (mode === "auto") {
      mode =
        obj.source === "f1-signalr" ||
        (typeof obj.topic === "string" &&
          !obj.topic.startsWith("v1/") &&
          /^[A-Z]/.test(obj.topic))
          ? "signalr"
          : "openf1";
    }
    obj.source = obj.source || (mode === "signalr" ? "f1-signalr" : "ndjson");
    const expand =
      mode === "signalr"
        ? (row) => expandSignalRLine(row, signalrMerge)
        : expandOpenF1Line;
    for (const ev of expand(obj)) {
      yield ev;
    }
  }
}
