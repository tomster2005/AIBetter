# Deploying the frontend (static site)

The UI is a **Vite + React** SPA. The **API** stays on Render (`https://aibetter.onrender.com`) — you can host the built files on any static host.

## Build

```bash
npm ci
npm run build
```

- **Output directory:** `dist/`
- **Framework:** Vite (not Next.js). On Vercel/Netlify choose the Vite preset or “Other” with the commands below.

### Host settings (typical)

| Setting        | Value        |
|----------------|-------------|
| Install        | `npm ci`    |
| Build          | `npm run build` |
| Publish / Output | `dist`    |

## Routing

There is **no client-side router** (tabs only). Users always load `/`. You do **not** need SPA fallback rules for deep links unless you add routes later.

## API calls and localhost

- **Dev:** `npm run dev` uses Vite’s proxy (`vite.config.ts`) for `/api/*` → `http://localhost:3001`. Shared bets use `http://localhost:3001` in dev (`betTrackerService.ts`).
- **Production build:** Shared bet CRUD uses **`https://aibetter.onrender.com`** (see `API_BASE` in `src/services/betTrackerService.ts`). No production dependency on `localhost` for that flow.

Some screens use **relative** URLs such as `fetch("/api/fixtures?...")`. On a static host, that hits **your static origin**, not Render, unless you add **rewrites** (see below).

## Rewrites (recommended): `/api/*` → Render

So Calendar and other relative `/api/...` calls work without changing app code, proxy `/api` to your API:

- **Vercel:** `vercel.json` in this repo (rewrites to Render).
- **Netlify:** `netlify.toml` in this repo.

Adjust the destination URL if your API hostname changes.

## Environment variables (frontend build)

| Variable            | When to set | Purpose |
|---------------------|-------------|---------|
| `VITE_API_ORIGIN`   | Optional    | Used by some modules (e.g. player props, backtest snapshots) to prefix API URLs. If unset, those paths are **relative** (`/api/...`), which is correct **if** you use host rewrites as above. Set to `https://aibetter.onrender.com` only if you intentionally want **cross-origin** API URLs at build time (then the API must allow your site’s origin — CORS). |

**Shared bets** do not use `VITE_API_ORIGIN`; they use the fixed `API_BASE` in `betTrackerService.ts`.

## CORS (important)

Production builds call **`https://aibetter.onrender.com/api/bets`** from your static site’s origin (e.g. `https://….vercel.app`). The browser requires **CORS** on the API for those requests.

If bets fail in the network tab with a CORS error, allow your static site’s origin on the Render service (e.g. extend `server/index.ts` / env-driven `FRONTEND_ORIGINS` — not required for local dev).

## Static assets

`public/calibration.json` is copied into `dist/`; `fetch("/calibration.json")` works when the app is served from the site root (`base: "/"`).

## Render Static Site (optional)

Create a **Static Site** on Render, connect the repo, set:

- Build: `npm ci && npm run build`
- Publish: `dist`

Configure **redirects/rewrites** in the Render dashboard so `/api/*` proxies to your Web Service URL if you rely on relative `/api` calls.
