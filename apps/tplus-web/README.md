# tplus-web

Public **TPlus** site (Cloudflare Pages).

**Live:** [https://t-plus.pages.dev/](https://t-plus.pages.dev/)

The homepage **is** the alert feed (recent flights stay visible between launches).
`/live` redirects to `/`. One CTA: “Get on your phone” → Telegram.

## Preview / deploy

```bash
npm run web:preview:tplus   # from monorepo root
npm run cf:deploy:tplus-web
```

Feed API: `https://tplus.scenicminddigital.workers.dev/recent`.
