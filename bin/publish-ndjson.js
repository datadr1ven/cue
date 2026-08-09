#!/usr/bin/env node
/**
 * Publish NDJSON capture lines to a local MQTT broker.
 *
 *   npm run publish -- path/to/session.ndjson max
 *   npm run publish -- path/to/session.ndjson respect 10
 */

import mqtt from "mqtt";
import byline from "byline";
import fs from "fs";
import { config } from "../src/config.js";

const filePath = process.argv[2];
const timingMode = process.argv[3] || "max";
const multiplier = parseFloat(process.argv[4] || "1");

if (!filePath) {
  console.error(
    "Usage: npm run publish -- <file.ndjson> [max|respect] [speedMultiplier]",
  );
  process.exit(2);
}

const client = mqtt.connect({
  host: config.mqttLocalHost,
  port: config.mqttLocalPort,
});

client.on("connect", async () => {
  console.log(
    `Publishing ${filePath} → ${config.mqttLocalHost}:${config.mqttLocalPort} mode=${timingMode}`,
  );
  const stream = byline(fs.createReadStream(filePath, { encoding: "utf8" }));
  let lastTime = null;
  let n = 0;

  for await (const line of stream) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (timingMode === "respect" && event.receivedAt) {
      const eventTime = new Date(event.receivedAt).getTime();
      if (lastTime != null) {
        const delay = (eventTime - lastTime) / multiplier;
        await new Promise((r) => setTimeout(r, Math.max(delay, 0)));
      }
      lastTime = eventTime;
    }

    const payload = event.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      payload.receivedAt = event.receivedAt;
    }

    await new Promise((resolve, reject) => {
      client.publish(
        event.topic,
        JSON.stringify(payload),
        { qos: 0, retain: false },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    n += 1;
    if (n % 5000 === 0) console.log(`${n} published…`);
  }

  console.log(`Done — ${n} messages`);
  client.end();
});

client.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
