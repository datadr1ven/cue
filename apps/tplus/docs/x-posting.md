# TPlus → X (Twitter) end-of-flight posts

After a `webcast:live` run, `webcast:summary` builds a **collage + caption** from the run archive. Posting to X is optional and **off by default**.

## Do I need a special / paid X account?

**You do not need a special “business” X profile** — a normal account for TPlus is fine.

You **do** need:

1. **X Developer access** for that account — [console.x.com](https://console.x.com) / [developer.x.com](https://developer.x.com)
2. A **Project + App** with permission to **create posts**
3. **Pay-per-use API credits** — as of 2026 there is **no free write tier** for new apps. You buy credits in the Developer Console and get charged per call.

You do **not** need X Premium just to post a still (Premium mainly raises *video* length caps).

### Pricing that matters for us

Official pay-per-use rates (see [docs](https://docs.x.com/x-api/getting-started/pricing); confirm in console):

| Action | Approx. cost |
|--------|----------------|
| Create a post (no URL) | **$0.015** |
| Create a post **with a URL** | **$0.20** |

Our funnel caption includes a link to `tplus-web`, so plan on **~$0.20 per launch summary** (plus tiny media-related charges if any). Set a spending limit in the console while testing.

## Where to get keys

1. Sign in at [https://console.x.com](https://console.x.com) with the **TPlus** X account (or an account that will own the app).
2. Create a **Project** and an **App**.
3. Purchase a small credit pack / set a spending limit.
4. In the app settings, enable **Read and write** (user auth).
5. Generate **OAuth 1.0a** user access tokens for the TPlus account:
   - API Key  
   - API Key Secret  
   - Access Token  
   - Access Token Secret  

Those four go into `~/cue/.env` (never commit them):

```bash
TPLUS_X_API_KEY=
TPLUS_X_API_SECRET=
TPLUS_X_ACCESS_TOKEN=
TPLUS_X_ACCESS_SECRET=
# Required to allow live posts (CLI still needs --post)
TPLUS_X_ENABLED=0
```

Optional funnel overrides:

```bash
TPLUS_LANDING_URL=https://t-plus.pages.dev/
TPLUS_TELEGRAM_URL=https://t.me/TPlusLaunchBot?start=x
```

## CLI (manual pushbutton — recommended)

X’s compose URL can **prefill text**, but not a local image. The pushbutton flow:

### From anywhere (laptop / Termux) — use the public feed

No run folder copy needed. Pulls `GET /recent` from the TPlus Worker (same data as [t-plus.pages.dev](https://t-plus.pages.dev/)):

```bash
npm run webcast:summary -- --from-feed --open
npm run webcast:summary -- --from-feed --mission Crew-13 --open
```

Writes under `tplus-webcast/summaries/<stamp>-<mission>/`.  
**Stills:** only if ops `/suggest` rehosted photos onto the feed (`imageUrl`). Older text-only flights → caption-only draft.

### From a local run archive (desktop that saved frames)

```bash
npm run webcast:summary -- --latest --open
```

That builds the summary, opens:

1. **`post.html`** — collage preview + “Open draft on X” + copy buttons  
2. **X compose** (`x.com/intent/post?text=…`) — caption already filled  

Then: glance → drag/paste the collage into the composer → **Post**.

```bash
# Files only (no browser)
npm run webcast:summary -- --from-feed
npm run webcast:summary -- --run tplus-webcast/runs/<runId>

# Live API post later (only when ENABLED=1 and keys present)
TPLUS_X_ENABLED=1 npm run webcast:summary -- --latest --post
```

Outputs land in `<runDir>/summary/`:

- `collage.jpg` — grid of highlight stills  
- `caption.txt` — short X text (includes landing URL)  
- `synopsis.txt` — longer milestone list (for notes / threads later)  
- `post.html` — local review / pushbutton page  
- `intent-url.txt` — same compose link (handy on phone if you sync the file)  
- `manifest.json`

## Auto after stop (optional)

`webcast-ctl.sh stop` can run a dry-run summary when `TPLUS_SUMMARY_ON_STOP=1` (see script). Live X still requires `TPLUS_X_ENABLED=1` and an explicit future hook if you want unattended posts.
