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
| 50 teams x 3 devices (150 devices) | 7,091 | 0 | 50/50 | 10 ms / 1.2 s | 1.3 s median |
| 100 teams x 3 devices (300 devices) | 13,991 | 0 | 100/100 | 11 ms / 1.1 s | 3.8 s median |

The slow percentiles all come from the first few seconds, when every team signs in at once (PIN hashing is deliberately CPU-heavy). After that, every request type had a median under 30 ms.

## Recommended hosting: Azure App Service (always-on container)

For a single-day event with a known number of players, one always-on server is simpler and more predictable than serverless:

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
| `ADMIN_CONSOLE_PATH` | yes | Secret path of the organizer console (16+ characters of letters, digits, `-`, `_`). The console is disabled when unset |
| `ADMIN_ALLOWED_IPS` | no | Comma-separated IPs or CIDR ranges allowed to open the console |
| `MONGODB_URI` | yes | MongoDB connection string |
| `MONGODB_DATABASE` | no | Database name (default `data_tycoon`) |
| `MONGODB_MAX_POOL_SIZE` | no | Connections per process (default 20) |
| `WEB_CONCURRENCY` | no | Gunicorn worker processes in Docker (default 2) |

Generate secrets with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"            # session secret
python -c "import secrets; print('ops-' + secrets.token_urlsafe(18))"   # console path
```

## The organizer console

* The console lives only at `https://<domain>/<ADMIN_CONSOLE_PATH>/`. There is no link to it anywhere on the player site, `/admin` and `/admin.html` return 404, and every `/api/admin/*` endpoint answers 404 unless the request carries the console path. The page is marked `noindex`.
* Share the URL only with the organizing team. To change it, update `ADMIN_CONSOLE_PATH` and redeploy.
* Organizer sign-in is rate limited (8 failed attempts per IP per minute, 40 overall per 5 minutes).
* **Reset PIN** signs out every device of that team. The next PIN the team enters becomes their new PIN, so ask the team to sign in right away.

## Before the event checklist

1. Upgrade the database tier and set all environment variables on the production host.
2. Clear test data: `MONGODB_URI=... python scripts/reset_event_data.py --yes` (otherwise old test teams use up industry seats).
3. Open the console, set the flash timer and the round wait the way you want them.
4. Do a dry run with two or three phones and laptops (Windows, macOS, Android, iOS).
5. Keep the console open during the event to watch alerts.

## Changing the flashes

Replace the PDFs in `content-src/flashes/` and run `python scripts/build_flash_images.py` (needs `pdftoppm` from poppler-utils and Pillow). Commit the regenerated images in `api/_private/flashes/`. The PDFs themselves are never deployed.
