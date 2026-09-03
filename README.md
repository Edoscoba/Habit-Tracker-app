# Daily Habit — deployment package

A self-contained habit/streak tracker: one HTML file plus a tiny Node server.
No dependencies, no build step, no database required.

## Deploy on GuildServer (guild-technologies.com)

Option A — GitHub deploy (recommended):
1. Push this folder to a GitHub repository (files at the repo root).
2. In GuildServer, create a new app from that repository and pick the Node runtime.
3. Start command: `npm start` (the server honors the `PORT` environment variable).
4. Attach your domain (e.g. habits.guild-technologies.com) and GuildServer's TLS takes care of HTTPS.

Option B — Docker:
The included `Dockerfile` builds a ~50 MB image that serves the app on `$PORT`
(defaults to 3000). Use it as-is with GuildServer's container deploy, or let
GuildServer auto-generate its own — either works.

Health check endpoint: `GET /healthz` → `200 ok`.

## Where the data lives

This copy stores each visitor's habits and check-ins in **their own browser**
(localStorage). That means:
- It works instantly for any visitor, with no accounts and no server database.
- Data does not sync between devices or browsers, and clearing site data erases it.
- It is completely separate from the claude.ai copy of the app — check-ins made
  here are not seen by the claude.ai version or its 8 PM reminder.

If you later want accounts and cross-device sync on your own server, the app
needs a small backend API and a database (GuildServer supports both) — the
storage layer in `index.html` is already an adapter, so it can be pointed at an
API without rewriting the app.

## Files

- `index.html` — the entire app (UI + logic, works on any static host)
- `server.js` — zero-dependency static server, `PORT`-aware
- `package.json` — `npm start` runs the server
- `Dockerfile` — optional container route
