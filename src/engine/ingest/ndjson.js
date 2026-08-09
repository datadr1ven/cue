/**
 * Read OpenF1-style capture NDJSON and yield normalized IngestEvents.
 */

import { createReadStream } from "fs";
import readline from "readline";
import { expandOpenF1Line } from "./openf1.js";

/**
 * @param {string} filePath
 * @param {object} [opts]
 * @returns {AsyncGenerator<import('../types.js').IngestEvent>}
 */
export async function* readNdjsonEvents(filePath, opts = {}) {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

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
    obj.source = obj.source || "ndjson";
    for (const ev of expandOpenF1Line(obj)) {
      yield ev;
    }
  }
}
