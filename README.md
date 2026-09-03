# Daily Habit — with accounts & cross-device sync

A habit/streak tracker: one HTML file plus a single Node server file.
Works instantly for guests (data in their own browser), and visitors can
optionally **create an account to sync habits across devices**.

Storage auto-selects:

- **Postgres** when a `DATABASE_URL` (or `PG*`) environment variable is set —
  durable, survives redeploys. **Recommended for production.**
- **SQLite** otherwise — a file in `DATA_DIR` (default `/app/data`). Zero setup,
  but on a platform that rebuilds the container each deploy the file is lost on
  the next redeploy. Fine for local dev or a demo.

## Deploy on GuildServer (guild-technologies.com) with durable accounts

1. **Create a Postgres database.** Dashboard → Databases → Create Database →
   Postgres. When it's ready, copy its connection string (looks like
   `postgres://user:pass@host:5432/dbname`).
2. **Give the app the connection string.** Open the app → Environment →
   add a variable `DATABASE_URL` = the connection string → Add.
   (If your provider needs TLS and the string has no `sslmode`, also add
   `PGSSL=require`. To force TLS off, `PGSSL=disable`.)
3. **Redeploy** the app. On boot the logs will say
   `... [storage: postgres]` — that confirms it's using the database.
   The app creates its own tables automatically on first start.
4. Accounts and synced data now survive every future redeploy.

No `DATABASE_URL`? The app still runs and stores accounts in SQLite at
`/app/data`; attach persistent storage there if your platform offers it, or
accounts reset on redeploy.

### If the app can't reach the database (Container Logs show timeouts)

Single-host platforms sometimes advertise a database on a public
`host:port` that their own firewall blocks from inside app containers. The
server keeps running for guests (sync API answers 503) and retries every
15 s, trying in order: the string as given → the container's host gateway →
internal container names. Two non-secret env vars steer it:

- `DB_INSTANCE_NAME=<database instance name>` (e.g. `daily-habit-db`) — the
  app resolves well-known container-name patterns on the internal Docker
  network and connects on port 5432 (`DB_INTERNAL_PORT` to change).
- `DB_HOST_OVERRIDE=<host[:port]>` — force a specific internal host, keeping
  the user, password and database from `DATABASE_URL`.

Each attempt is logged with credentials redacted, so the logs tell you which
route worked. `PGSSL=require|disable` forces TLS on/off; `PG_NO_HOST_FALLBACK=1`
disables the gateway attempts.

Health check: `GET /healthz` → `200 ok`. The server listens on `$PORT`
(default 3000).

## Reminders & habit windows (push notifications)

Each habit can have a **daily reminder hour**, and good habits can have a
**window** (e.g. 7:00–8:00). Signed-in users who enable notifications on a
device (account button → *Notifications on this device* → Enable) get:

- a reminder at the reminder hour,
- "Time for …" when a window opens and "… window ended — did you do it?" when
  it closes — both skipped automatically once the habit is checked in for the day.

Times are whole hours in the **device's** time zone (each device records its
zone when it enables notifications). Notifications are real Web Push: they
arrive with the site closed. On iPhone/iPad the site must first be added to
the Home Screen (Share → Add to Home Screen) and opened from there — the app
ships a manifest and icons so it installs cleanly.

Server side: VAPID keys are generated once and stored in the database (or
set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`); set `VAPID_SUBJECT` to your
site URL or a `mailto:` address. A ticker runs every 30 s and sends at most
one notification per device, habit and kind per hour; expired subscriptions
are pruned automatically. Endpoints: `GET /api/push/vapid`,
`POST /api/push/subscribe|unsubscribe|test`, `GET /api/push/status`;
assets: `/sw.js`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`,
`/apple-touch-icon.png`.

## How accounts work

- Optional: guests use the app with data stored in their browser, no sign-up.
- "Create account" = email + password (min 8 chars). Passwords are stored as
  scrypt hashes; sessions are HttpOnly cookies (120 days, sliding).
- On first sign-in from a browser that has guest data, that data is imported
  into the account automatically.
- Signing out returns the browser to its guest data. Account data stays in the
  database for the next sign-in, from any device.
- Rate limiting protects the login/registration endpoints.
- **Not included yet:** password reset by email and email verification. Choose a
  password you'll remember.

## API (used by the app itself)

`POST /api/register` · `POST /api/login` · `POST /api/logout` · `GET /api/me`
`GET /api/data` · `POST /api/import`
`PUT/DELETE /api/habits/:id` · `PATCH /api/day` · `PATCH /api/note`
All JSON; mutating calls require the `x-dh: 1` header.

## Files

- `index.html` — the entire app UI (also runs standalone on any static host)
- `server.js` — static serving + auth + sync API + storage (SQLite or Postgres)
- `package.json` / `package-lock.json` — dependencies `pg` and `web-push`; `npm start` runs it
- `Dockerfile` — container route (node:24-alpine, `npm ci`)

## Run locally

```
# SQLite (no setup) — data in ./data
npm install
node server.js               # → http://localhost:3000

# Postgres
DATABASE_URL=postgres://user:pass@localhost:5432/habitdb node server.js
```
