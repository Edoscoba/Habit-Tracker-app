# Daily Habit — with accounts & cross-device sync

A habit/streak tracker: one HTML file plus a single Node server file.
Works instantly for guests (data in their own browser), and visitors can
optionally **create an account to sync habits across devices**.
No npm dependencies — the database is SQLite via Node's built-in driver.

## Deploy on GuildServer (guild-technologies.com)

1. Deploy this repo as before (Dockerfile route, or Node runtime with `npm start`).
   The server listens on `$PORT` (defaults to 3000). Health check: `GET /healthz`.
2. **IMPORTANT — attach persistent storage at `/app/data`.**
   Account data lives in a SQLite file inside `/app/data`. If the app's settings
   offer a volume / persistent storage / mount option, point it at `/app/data`.
   Without it, accounts and synced data reset on every redeploy.
   (Guest/browser-only usage is unaffected either way.)
   You can also set the `DATA_DIR` env var to move the database elsewhere.
3. Redeploy. Done — the app now shows a "Sign in to sync" account button.

## How accounts work

- Optional: guests use the app with data stored in their browser, no sign-up.
- "Create account" = email + password (min 8 chars). Passwords are stored as
  scrypt hashes; sessions are HttpOnly cookies (120 days, sliding).
- On first sign-in from a browser that has guest data, that data is imported
  into the account automatically.
- Signing out returns the browser to its guest data. Account data stays on the
  server for the next sign-in, from any device.
- Rate limiting protects the login/registration endpoints.
- **Not included yet:** password reset by email (needs an email service) and
  email verification. Choose a password you'll remember.

## API (used by the app itself)

`POST /api/register` · `POST /api/login` · `POST /api/logout` · `GET /api/me`
`GET /api/data` · `POST /api/import`
`PUT/DELETE /api/habits/:id` · `PATCH /api/day` · `PATCH /api/note`
All JSON; mutating calls require the `x-dh: 1` header (CSRF belt-and-braces on
top of SameSite=Lax cookies).

## Files

- `index.html` — the entire app UI (also runs standalone on any static host)
- `server.js` — static serving + auth + sync API + SQLite storage (no deps)
- `package.json` — `npm start` runs the server (Node ≥ 22)
- `Dockerfile` — container route (node:24-alpine), data at `/app/data`

## Run locally

```
node server.js
# → http://localhost:3000  (database appears in ./data/)
```
