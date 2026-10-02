# gridwhisper-web

Public **GridWhisper** site (Cloudflare Pages).

**Live:** [https://gridwhisper.pages.dev/](https://gridwhisper.pages.dev/)

The homepage **is** the race alert feed. `/live` redirects to `/`.
One CTA: “Get on your phone” → Telegram. Banner + **?** for a short explainer.

## Preview / deploy

```bash
npm run web:preview:gridwhisper   # from monorepo root
npm run cf:deploy:gridwhisper-web
```

Feed API: `https://gridwhisper.scenicminddigital.workers.dev/recent`.
