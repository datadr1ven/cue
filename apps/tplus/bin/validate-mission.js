#!/usr/bin/env node
/**
 * Validate mission index + flight JSON before commit.
 *
 *   npm run validate:missions
 *   npm run validate:missions -- 14
 *   npm run validate:missions -- path/to/starship-flight-14-script.json
 */

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import {
  validateMissions,
  validateMissionDoc,
  MISSIONS_ROOT,
  loadMission,
} from "../src/missions/registry.js";

const arg = process.argv[2];

function printResult(r, label) {
  if (r.warnings?.length) {
    for (const w of r.warnings) console.warn(`WARN  ${w}`);
  }
  if (r.errors?.length) {
    for (const e of r.errors) console.error(`ERROR ${e}`);
  }
  if (r.ok) {
    console.log(`OK  ${label}`);
    return 0;
  }
  console.error(`FAIL  ${label}`);
  return 1;
}

let code = 0;

if (!arg) {
  const r = validateMissions(MISSIONS_ROOT);
  code = printResult(r, `all missions under ${MISSIONS_ROOT}`);
} else if (existsSync(resolve(arg)) && arg.endsWith(".json")) {
  const path = resolve(arg);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const errors = [];
  const warnings = [];
  validateMissionDoc(doc, path, errors, warnings);
  code = printResult({ ok: errors.length === 0, errors, warnings }, path);
} else {
  const loaded = loadMission(arg);
  if (!loaded) {
    console.error(`Unknown mission ref: ${arg}`);
    process.exit(2);
  }
  const errors = [];
  const warnings = [];
  validateMissionDoc(loaded.doc, loaded.path, errors, warnings);
  code = printResult(
    { ok: errors.length === 0, errors, warnings },
    `${loaded.entry.id} (${loaded.path})`,
  );
}

process.exit(code);
