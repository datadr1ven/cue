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

T−30 → window close +30.

| Alias | LL2 id | Cron start (MDT) | Cron stop (MDT) |
|-------|--------|------------------|-----------------|
| `o3b-mpower-f` | `ad358a4d-…` | Sun Sep 13 **12:19** | Sun **14:46** |
| `ussf-259` | `17c71937-…` | Tue Sep 15 **18:30** | Tue **23:30** |
| `starlink-sl-15-27` | `d1471f9d-…` | Sat Sep 19 **19:17** | Sun **00:17** |

If NET slips outside the published window, update crontab or start manually.

Requires `TPLUS_SUGGEST_*` + Telegram secrets in `~/cue/.env`. CLI `--mode ops` overrides `TPLUS_MODE=test`.

Worker `/suggest` is mission-agnostic (no CF redeploy when LL2/NET changes). Deploy the Worker only for Worker code changes.
