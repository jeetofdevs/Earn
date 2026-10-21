<p align="center"><img src="brand/logo-512.png" width="120" alt="EARN logo"></p>

# $EARN — Hold and earn tax rewards on NEAR

Landing page for **$EARN**, a tax rewards token on NEAR: every buy and sell is
taxed, and the tax goes back to holders. Buy on [justhoot.fun](https://justhoot.fun/).

| Folder | What it is |
|---|---|
| `web/` | The website (Vite) and a tiny Node server that serves it |
| `brand/` | Logo, Twitter/X cover, first launch post (`brand/posts/`) |

## Run locally

```bash
cd web
npm install
npm run dev                  # http://localhost:5173
npm run build && npm start   # production build on http://localhost:3000
```

## Deploy on Railway

The repo root has a `Dockerfile`, `railway.json` and a root `package.json`, so
Railway builds and serves it with no settings. **Deploy from GitHub repo →
leave Root Directory empty → Generate Domain.** No variables or volume needed.

## Editing

- Text and links: `web/index.html` (buy links point to `https://justhoot.fun/`)
- Colors and layout: `web/src/style.css`
- Logo: `brand/logo.svg` (copy to `web/public/logo.svg`)
