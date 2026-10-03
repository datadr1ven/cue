# Launch event rules (human guide)

What TPlus *means* to alert on, in plain language.  
**Runtime today:** desktop `webcast:live` (OCR clock + LL2/script milestones) → Worker `/suggest` fan-out.  
**Catalog:** `packages/cue/src/engine/domains/starship/actions.js` (`LAUNCH_ACTIONS`).  
**Sensing roadmap:** [SENSORS.md](./SENSORS.md).

---

## Brief — what fans should see

TPlus turns a launch webcast into the **milestones that matter** — not a second countdown clock. Prefer silence between beats. Webcasts and schedules can lag; this is unofficial.

### You get

| When | What |
|------|------|
| On the plan | Liftoff, Max-Q, MECO / stage sep, fairing, boostback / entry / landing burns, booster landing or catch, payload deploy — **as listed for that mission** |
| Window | Hold / scrub / go when the desk marks them |
| After flight | Still frames on many ops alerts; end-of-flight summary tooling when used |

Mission timelines come from [Launch Library 2](https://thespacedevs.com/) when available. If LL2 only has liftoff, the public stream is mostly liftoff until a fuller script exists.

### You don’t get

| Skip | Why |
|------|-----|
| Every T− second | Not a countdown bot |
| Every on-screen graphic change | Noise |
| Guaranteed Max-Q / landing if the script is empty | Script gates most emits; ASR alone does not fan out |
| Provider-official status | Unofficial fan desk |

### FAQ

**Why only liftoff for some flights?**  
LL2 sometimes ships NET + webcast with an empty timeline (common on rideshares). TPlus won’t invent Max-Q from thin air.

**Why a footnote about audio on an alert?**  
Optional ASR can corroborate a milestone. It’s weak evidence, not the primary clock.

**Does this replace watching the webcast?**  
No — it’s a push feed of beats so you can look up when something happens.

---

## Operator appendix

- **Primary clock:** OCR on the webcast T+ / hold overlay (hold-aware).
- **Script:** LL2 → `ll2.js` mapping → mission `actionId`s; unknown abbrevs slugify rather than drop.
- **ASR:** Phrase hits are logged / footnoted; fan-out still requires the action on the mission script (see `webcast:live` gating).
- **Modes:** `--mode test` → admins only; `--mode ops` → subscribers + public feed.
- **HITL:** `/ops` can fire catalog actions; slug-only script ids may emit from the desk without appearing as buttons.

Source of truth for fireable ids: `LAUNCH_ACTIONS`. Sensing fusion plan: [SENSORS.md](./SENSORS.md).
