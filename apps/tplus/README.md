# TPlus

SpaceX launch sparse alerts built on **Cue**.

- **Missions:** git timelines under `missions/`  
- **Always-on (Cloudflare):** enroll + `POST /suggest` (`mode=test|ops`)  
- **Laptop live path:** `webcast:live` — park on a broadcast URL, OCR the mission clock (hold-aware), optional ASR, emit at script T+  

Retired: public `/ops` mission-browse menu and Approve/Dismiss suggest flow.

## Quick commands (from monorepo root)

```bash
npm run validate:missions
npm run smoke:tplus
npm run webcast:live -- --mission o3b-mpower-f --mode test
# optional: --url 'https://x.com/i/broadcasts/…' overrides mission webcastUrl
npm run cf:deploy:tplus
```

## End-of-flight summary (collage + optional X)

```bash
# Laptop / Termux / anywhere with network (uses public feed):
npm run webcast:summary -- --from-feed --open

# Desktop with local run frames:
npm run webcast:summary -- --latest --open
```

Manual flow details: [docs/x-posting.md](./docs/x-posting.md).

## Docs

- [Cloudflare](./docs/cloudflare.md)  
- [Webcast consumer](./src/webcast/README.md)  
- [X posting](./docs/x-posting.md)  


## Layout

```text
apps/tplus/
  bin/          webcast-*, validate-mission, starship-*, smokes
  src/          session, commands, missions loaders, webcast/
  missions/     index.json + flights/*.json
  worker/       CF Worker entry
  docs/
  wrangler.toml
```

Starship **domain** (detect/render) lives in `packages/cue` so other apps can reuse it. Mission JSON and webcast stay here.
