# Deploying and running Data Tycoon

## Why the site was hanging

Several problems compounded each other in the previous version:

1. **17 MB flash PDFs** were downloaded and rendered in the browser with pdf.js loaded from a CDN. On event Wi-Fi this looked like a frozen screen. Flashes are now about 1.4 MB per round (six WebP pages), served by our own API.
2. **No request timeouts.** Any slow request left buttons stuck on "CONNECTING…" until the page was reloaded. Every request now times out after 12 seconds with a clear message, and the page keeps retrying in the background.
3. **Database pressure.** Each player made 5 to 6 different polling requests (seat counts alone ran five database counts every 10 seconds per player), plus the organizer dashboard every 2 seconds. With 50 players that is well past the MongoDB Atlas free tier's documented limits (about 100 operations per second and 100 connections), and serverless platforms open new connections for each concurrent instance. Players now make **one** poll every 5 seconds (one database read, plus a write at most every 10 seconds), public data is cached, and the organizer dashboard polls every 3 seconds.
4. **Blocking database calls on the async event loop** (in the old FastAPI handler) meant one slow query stalled every other request on the same instance. Handlers now run on a thread pool.
5. **Render-blocking Google Fonts** delayed the first paint on slow networks. Fonts are now self-hosted.
6. **Client and server state drifting apart** (the browser kept its own copy of the game in localStorage) caused the "refresh to fix it" behavior. The server is now the single source of truth and the page updates itself from it.

## Load test results

`tests/load/load_test.py` plays complete four-round games with many simulated teams at once: real request pattern, every flash page downloaded, integrity alerts sent, and one organizer console polling. It ran in a 4-core container that was also running MongoDB and the load generator, with 2 gunicorn workers (the Docker configuration):

| Scenario | Requests | Errors | Teams finished | Poll p50 / p99 | Sign-in during the opening rush |
|---|---|---|---|---|---|
| 50 teams, one laptop each, **single process** (event setup) | 4,104 | 0 | 50/50 | 11 ms / 2.0 s | 1.2 s median |
| 50 teams x 3 devices, 2 processes (stress) | 7,091 | 0 | 50/50 | 10 ms / 1.2 s | 1.3 s median |
| 100 teams x 3 devices, 2 processes (stress) | 13,991 | 0 | 100/100 | 11 ms / 1.1 s | 3.8 s median |

The test squeezes a whole four-round game into about 100 seconds, so the request rate is far higher than during the real event (where each round lasts 30 minutes or more).

The slow percentiles all come from the first few seconds, when every team signs in at once (PIN hashing is deliberately CPU-heavy). After that, every request type had a median under 30 ms.

## Which host?

**For 50 teams, stay on Vercel and upgrade the database tier.** The new code sends a small, steady load (about 10 requests per second with 50 players, mostly single database reads, and public data is cached by Vercel's CDN), so Vercel handles it comfortably. What Vercel cannot fix is a throttled database, so the database tier is the one upgrade that matters. Switching hosts days before the event adds risk without a clear gain at this size.

Azure is the fallback if you see problems on Vercel during the rehearsal, or if you grow well beyond 50 teams. The Docker image is ready for that.

## Alternative hosting: Azure App Service (always-on container)

An always-on server avoids serverless trade-offs:

* No cold starts, and a stable pool of database connections.
* No 4.5 MB response cap and no per-invocation time limits.
* In-process caches (settings, leaderboard, verified PINs) work as designed.

### Steps

1. **Database.** Use a MongoDB that is not the free tier for the event:
   * MongoDB Atlas Flex or M10, in the same region as the app (for example Central India), or
   * Azure Cosmos DB for MongoDB (vCore), which uses Azure credits. The app only needs standard MongoDB features (indexes, TTL indexes, `find_one_and_update`).
   Allow the app's outbound IPs in the database network settings.
2. **Build the image** (from the repository root):
   ```bash
   az acr create -g <resource-group> -n <registry> --sku Basic
   az acr build -r <registry> -t data-tycoon:latest .
   ```
3. **Create the web app** (Linux, Basic B2 or Premium P1v3 recommended for the event; B1 is enough for rehearsals):
   ```bash
   az appservice plan create -g <resource-group> -n data-tycoon-plan --is-linux --sku B2
   az webapp create -g <resource-group> -p data-tycoon-plan -n <app-name> \
     --deployment-container-image-name <registry>.azurecr.io/data-tycoon:latest
   az webapp config set -g <resource-group> -n <app-name> --always-on true --http20-enabled true
   az webapp config appsettings set -g <resource-group> -n <app-name> --settings \
     WEBSITES_PORT=8000 WEB_CONCURRENCY=2 \
     ADMIN_PASSWORD='...' ADMIN_SESSION_SECRET='...' ADMIN_CONSOLE_PATH='ops-...' \
     MONGODB_URI='...' MONGODB_DATABASE=data_tycoon
   az webapp update -g <resource-group> -n <app-name> --https-only true
   ```
4. In the portal, set **Health check** to `/api/health`.
5. Keep **one instance**, or enable ARR affinity if you scale out. The app works across instances (all game state is in MongoDB), but one B2/P1v3 instance comfortably covers 50 teams.
6. Open `https://<app-name>.azurewebsites.net/api/health`. It should return `{"ok":true,"service":"data-tycoon"}`.

Azure Container Apps also works with the same image (set minimum replicas to 1 so it never scales to zero).

## Vercel (still supported)

`vercel.json` deploys the same code: static files from `public/`, and everything else through `api/index.py`.

* Set the same environment variables in **Settings → Environment Variables** and redeploy.
* The responses stay below Vercel's 4.5 MB function payload limit (largest response: about 260 KB).
* Before the event, upgrade the database from the free tier (see above). That is the most likely cause of the production hangs.
* **Verify on a preview deployment first.** I could not deploy to Vercel from here, so check that `/`, `/api/health`, a flash page and the console URL all work on the preview before promoting it.

## Run locally

```bash
docker run -d --name data-tycoon-mongo -p 27017:27017 mongo:7
cp .env.example .env          # set ADMIN_PASSWORD, ADMIN_SESSION_SECRET, ADMIN_CONSOLE_PATH
pip install -r requirements-dev.txt
python server.py              # prints the player and console URLs
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Organizer password |
| `ADMIN_SESSION_SECRET` | yes | Long random secret that signs team and organizer sessions. Changing it signs everyone out |
| `ADMIN_CONSOLE_PATH` | no | Secret path of the organizer console (16+ characters of letters, digits, `-`, `_`). When unset, a path derived from the session secret is used (see `scripts/console_url.py`) |
| `ADMIN_ALLOWED_IPS` | no | Comma-separated IPs or CIDR ranges allowed to open the console |
| `MONGODB_URI` | yes | MongoDB connection string |
| `MONGODB_DATABASE` | no | Database name (default `data_tycoon`) |
| `MONGODB_MAX_POOL_SIZE` | no | Connections per process (default 5 on Vercel, 20 elsewhere) |
| `WEB_CONCURRENCY` | no | Gunicorn worker processes in Docker (default 2) |

Generate secrets with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"            # session secret
python -c "import secrets; print('ops-' + secrets.token_urlsafe(18))"   # console path
```

## The organizer console

* **Finding the URL.** If `ADMIN_CONSOLE_PATH` is set, the console is at `https://<domain>/<ADMIN_CONSOLE_PATH>/`. If it is not set, the path is derived from `ADMIN_SESSION_SECRET` (or `ADMIN_PASSWORD` when no session secret exists), so no URL is ever written into this public repository. Print it on your own computer with `python scripts/console_url.py`. Changing the password or secret changes the derived URL.
* The console lives only at that secret path. There is no link to it anywhere on the player site, `/admin` and `/admin.html` return 404, and every `/api/admin/*` endpoint answers 404 unless the request carries the console path. The page is marked `noindex`.
* Share the URL only with the organizing team. To change it, update `ADMIN_CONSOLE_PATH` and redeploy.
* Organizer sign-in is rate limited (8 failed attempts per IP per minute, 40 overall per 5 minutes).
* **One device per team.** Signing in on a new device signs the team's previous device out (it shows a message explaining why). A wrong PIN never signs anyone out.
* **Teams are created only in the console** (+ Add teams). Players cannot create teams or choose their own PIN. PINs are generated (6 digits) unless you type one; download them as CSV or print one card per team. PINS CSV re-downloads every team's current PIN at any time.
* **Set new PIN** (Manage dialog) replaces a team's PIN and signs out their device.
* **Rounds.** Nothing is open until you press Start Round 1. Open each later round yourself, or schedule it to open automatically in N minutes (players see the countdown). "Wait after a team submits" adds an optional minimum gap per team. Pause stops flashes, submissions and advancing for everyone.
* **Flash once.** Each round's flash can be opened once. It ends when the team closes it or when the timer runs out, even if their laptop died meanwhile. Use Manage > Re-enable flash to give a team one more viewing (fresh timer), or Mark flash as read to unlock their data without it.
* **Manage dialog** (click a team name): balance, PIN, sign out device, re-enable or complete the flash, undo the last submission, move to the next round or any round, rename, change industry (seat counts follow), private message, disqualify or reinstate, delete. Every action is logged under "Organizer actions".
* **Danger zone:** Delete all teams (type DELETE TEAMS) or Reset everything (type RESET) for a brand new game.

## Before the event checklist

1. Set all environment variables on the production host (including `ADMIN_CONSOLE_PATH`) and redeploy.
2. In the console, press Reset everything (type RESET) to remove test data.
3. Add the real teams (+ Add teams, or "Quickly make 50 teams"), then print the PIN cards or download the CSV.
4. Set the flash timer, the wait after submitting and, if you want it, the money between rounds (off by default). Leave the rounds closed until you are ready.
5. Do a dry run with two or three laptops (Windows and macOS), then Reset everything again and re-add teams.
6. On the day: teams sign in and choose an industry, then press Start Round 1. Keep the console open to watch progress and alerts.

## Changing the flashes

Replace the PDFs in `content-src/flashes/` and run `python scripts/build_flash_images.py` (needs `pdftoppm` from poppler-utils and Pillow). Commit the regenerated images in `api/_private/flashes/`. The PDFs themselves are never deployed.
