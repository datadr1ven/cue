# TPlus webcast automation

Unattended `webcast:live --mode ops`, resolving **NET + Official Webcast + timeline from Launch Library 2** (not hand-maintained mission JSON).

## Control

```bash
/home/datadr1ven/cue/apps/tplus/scripts/webcast-ctl.sh status
/home/datadr1ven/cue/apps/tplus/scripts/webcast-ctl.sh start o3b-mpower-f   # → --ll2-id …
/home/datadr1ven/cue/apps/tplus/scripts/webcast-ctl.sh stop o3b-mpower-f
```

Follow a run: `tail -f ~/cue/tplus-webcast/logs/<alias>.log`  
Cron wrapper: `~/cue/tplus-webcast/logs/cron.log`  

**Run archive** (cron passes `--save-run`):

```text
tplus-webcast/runs/<timestamp>-<missionId>/
  meta.json       # start/end, mode, webcastUrl, ll2 id
  script.json     # in-memory script used for the run
  ll2-raw.json    # LL2 payload when --ll2-*
  events.ndjson   # park / media_up / emit / suggest_ok / …
  suggest/        # per-milestone request+response
  frames/         # emit stills when artifacts enabled
```

Manual:

```bash
cd ~/cue
npm run webcast:live -- --ll2-id ad358a4d-c541-409b-9366-9c2f2da4aeb9 --mode test
npm run webcast:live -- --ll2-search 'O3b mPower' --dry-run
```

## LL2

- Free tier: **15 requests / hour / IP** (one fetch per webcast start is fine).
- Optional `LL2_TOKEN` in `~/cue/.env` for higher limits.
- Official Webcast only by default (`type.name === "Official Webcast"`).

## Schedule (America/Denver)

**Daily refresh** at **06:00 local** (1 LL2 call — fine vs 15/hour free tier):

```bash
npm run schedule:tplus -w tplus -- --apply-crontab
# preview only:
npm run schedule:tplus -w tplus -- --dry-run --apply-crontab
```

Writes `tplus-webcast/schedule.json` and replaces the crontab block between  
`# BEGIN TPLUS-WEBCAST` … `# END TPLUS-WEBCAST` (Spain / other crons untouched).

Rules: next **72h**, Official Webcast required, skip TBD/Success/vague month-level NET.  
Start = NET−30m, stop = window_end+30m. Scrubs that slip a day get picked up on the next morning run.

Hand aliases still work via `webcast-ctl.sh start <alias>` for known LL2 ids.

Requires `TPLUS_SUGGEST_*` + Telegram secrets in `~/cue/.env`. CLI `--mode ops` overrides `TPLUS_MODE=test`.

Worker `/suggest` is mission-agnostic (no CF redeploy when LL2/NET changes). Deploy the Worker only for Worker code changes.
