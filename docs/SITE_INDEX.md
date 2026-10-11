# Data Tycoon: Site Index

Map of every page, UI element, API route, storage key, timer and security control. See `docs/DEPLOYMENT.md` for hosting, environment variables and the pre-event checklist.

---

## 1. Architecture

| Layer | What runs it |
|---|---|
| Player site | Static files in `public/` (`index.html`, `src/app.js`, `src/flash.js`, `src/guard.js`, `src/styles.css`, `src/editorial.css`, `src/gameflow.css`, `src/newsroom.css`, `src/fonts.css`, `fonts/`) |
| API, private content, organizer console | `api/index.py` (FastAPI). On Vercel: one Python function (see `vercel.json`). Elsewhere: gunicorn/uvicorn via `Dockerfile` or `python server.py` |
| Game rules (answer key) | `api/_rules.py`, server side only |
| Private files | `api/_private/` (flash page images, datasets, console HTML/JS/CSS). Never served statically |
| Database | MongoDB (`MONGODB_URI`, `MONGODB_DATABASE`) |

**The server is the source of truth.** It scores every round, gates the flash and dataset, enforces the flash timer and the 30-minute round wait, and holds all team progress. The browser keeps only its session token and an unsent allocation draft.

Local development and production run the same code (`server.py` simply starts `api/index.py` with static file serving turned on).

## 2. File inventory

| Path | Role |
|---|---|
| `public/index.html` | Newspaper shell: utility bar, masthead, newsroom wire, step tabs, page container, flash overlay, confirm dialog, toasts |
| `public/src/app.js` | Player app: session, polling, rendering of all views, actions |
| `public/src/flash.js` | Flash viewer: fetches page images with the team token, draws them on canvas, adds the team watermark |
| `public/src/guard.js` | Flash integrity guard (screenshots, tab/app switching, printing, devtools, copy) |
| `public/src/styles.css`, `editorial.css`, `gameflow.css` | The original newspaper design, unchanged apart from removing the external font imports |
| `public/src/newsroom.css` | New pieces (step tabs, next-step bulletin, integrity screens, dialog, toasts, phone layout) in the same style |
| `public/src/fonts.css`, `public/fonts/*.woff2` | Self-hosted Libre Baskerville, Playfair Display and DM Mono |
| `api/index.py` | API routes, organizer console route, site fallback, security headers |
| `api/_rules.py` | Industries, parameters, rankings, multipliers, bands, validation, scoring, dataset file names |
| `api/_worker.py` | Gunicorn worker with a 75 s keep-alive (Docker/Azure) |
| `api/_private/flashes/flash-N/page-K.webp` | Rendered flash pages (6 per round, about 1.4 MB per round) |
| `api/_private/datasets/flashN/*` | 20 datasets (Food rounds 1 and 2 are `.xlsx`, everything else `.csv`) |
| `api/_private/console/` | Organizer console `admin.html`, `admin.js`, `admin.css` |
| `content-src/flashes/flash-N.pdf` | Source PDFs (not deployed). Rebuild images with `scripts/build_flash_images.py` |
| `scripts/reset_event_data.py` | Clears teams, activity, seat counters and rate limits before the event |
| `server.py` | Local / single-server runner |
| `Dockerfile`, `.dockerignore` | Always-on container for Azure App Service / Container Apps |
| `vercel.json`, `.vercelignore` | Vercel deployment |
| `tests/test_api.py`, `tests/conftest.py` | API tests (needs MongoDB) |
| `tests/test_migration.py`, `tests/fixtures/legacy_api.py` | Upgrade test: data written by the previous production version keeps working |
| `scripts/console_url.py` | Prints the organizer console URL from your secrets (runs locally) |
| `tests/e2e/e2e.cjs` | Browser end-to-end test (Playwright) |
| `tests/load/load_test.py` | Concurrent load test |

## 3. Player site

### 3.1 Shell (`public/index.html`): the original newspaper layout

| Element | ID | Behavior |
|---|---|---|
| Utility bar | `.utility-bar` | Edition label; `#utilityStatus` shows LIVE (green) or RECONNECTING (amber) plus team and industry desk; **SIGN OUT** (`#signOut`, confirms first) |
| Masthead | `.masthead` | DT seal, DATA TYCOON title (click returns to your current page), Special Edition stamp, mottos |
| Newsroom wire | `#wire` | Live status: round, next step, flash timer on/off, round wait on/off |
| Step tabs | `#steps` | Four tabs (see 3.2) |
| Page | `#page` | Next-step bulletin plus the current view |
| Flash overlay | `#flash` | Red flash bar (FLASH N OF 04, hint, live `#flashTimer` countdown or TIMER OFF), pages with team watermark, `#flashTimerNotice` (SCREEN LOCKED / TIMER OFF), green DONE READING button (hidden while the five-minute lock runs, exactly as before), shield `#flashShield`, "You left the flash" card `#flashLeaveCard` |
| Confirm dialog | `#confirmDialog` | Industry lock, submit, sign out |
| Toasts | `#toasts` | Success, info and error messages |

There is no link to the organizer console anywhere on the player site.

### 3.2 Step tabs and next-step bulletin

Tabs: **01 · Industry**, **02 · Round N of 4**, **03 · Results**, **Leaderboard**. Each shows a status line (for example "Food (locked)", "Download the dataset", "Round 1: ₹9,96,000"). The current tab is outlined in red, completed ones show a green check, and locked ones show a lock with the reason. On phones the strip scrolls sideways and keeps the current tab in view.

The **NEXT STEP** bulletin always says what to do now, with a button that does it:

| Stage | Bulletin | Button |
|---|---|---|
| No industry | Choose your industry desk | (cards below) |
| Flash not read | Read the Round N flash | OPEN FLASH |
| Dataset not downloaded | Download the Round N dataset | DOWNLOAD DATASET |
| Ready to invest | Invest ₹X and submit | GO TO THE DESK |
| Submitted, waiting | Round N+1 opens in mm:ss (live countdown) | VIEW RESULTS |
| Next round open | Round N+1 is open | PROCEED TO ROUND N+1 |
| Finished / eliminated | Final message | VIEW LEADERBOARD |

The page moves itself: after submitting it shows Results; when the next round opens the button appears without a reload; after advancing it shows the new round.

### 3.3 Views (original markup)

* **Login**: "WELCOME, ANALYSTS.", event rules, monitoring notice, NEWSROOM LOG IN form (Team ID / Name, Access PIN, notes, error, ENTER THE NEWSROOM). The last team name is remembered.
* **Industry**: STEP 1 heading, selection strip (SELECTED: … with CONFIRM & PROCEED), five INDUSTRY DESK cards with seats remaining and CHOOSE THIS INDUSTRY; confirming asks for confirmation. Locked teams see their industry and a link to their round.
* **Round dashboard**: LIVE MARKET DASHBOARD label, market tape (round budget, leaderboard rank, round progress, industry), HOW TO PLAY THIS ROUND (bonus or carried balance line, steps that tick off as you go, current flash timer and round wait settings), red MANDATORY STORYLINE FLASH box, DATASET box, NET CAPITAL TREND chart, and the INVESTMENT ALLOCATION DESK: ten parameters with minimum rule and live share, amount inputs that step by ₹1,000, a "+ REST" button per row that adds whatever is still unallocated, CLEAR ALL, the required / invested / remaining box, the validation line and LOCK & SUBMIT ROUND N (with confirmation). Each of the three sections carries a STEP tag (COMPLETE / DO THIS NOW / LOCKED).
* **Results**: ROUND 0N CLOSE heading, chart, FINANCIAL CLOSE card with FINAL ROUND PAYOUT, net profit, bonus, disqualification and rank, the parameter table, then the round-wait countdown with PROCEED TO ROUND N+1 (or the final leaderboard button). Earlier rounds are listed below.
* **Leaderboard**: OFFICIAL LEADERBOARD with 🥇 1ST / 🥈 2ND / 🥉 3RD badges, (YOU) highlight, round reached and net capital; back and REFRESH RANKINGS buttons; refreshes every 10 s while open.

### 3.4 Data flow and timers

| What | When |
|---|---|
| `GET /api/team/state` | Every 5 s (20 s when the tab is hidden and no flash is open; backs off on errors). Also immediately on return to the tab and when the network comes back |
| `GET /api/leaderboard` | Every 10 s while on Round, Results or Leaderboard |
| Countdown tick | Every 1 s, from server-provided remaining times (immune to wrong device clocks) |
| Request timeout | 12 s (20 s for sign-in, 30 s for datasets) |

Every action replaces the local state with the server's response, so the page never needs a reload. A second tab or a teammate's device converges within one poll.

### 3.5 Browser storage

| Key | Storage | Content |
|---|---|---|
| `dt-session-v2` | localStorage | `{teamId, token}` |
| `dt-draft-<team>-<round>-<budget>` | localStorage | Unsubmitted allocation inputs |
| `dt-organizer-session` | sessionStorage | Organizer token (console only) |

## 4. Game rules (server side, `api/_rules.py`)

* Start balance ₹10,00,000. Budget each round = current balance, plus ₹2,50,000 in rounds 2 and 3.
* Allocations must be whole rupees, at least ₹1,000 per parameter, and total exactly the budget.
* Each round ranks the ten parameters; rank maps to base multipliers 2.7, 1.8, 1.5, 1.2, 1.0, 0.8, 0.7, 0.5, 0.3, 0.
* Bands by share of budget: 2.7 is x0.8 up to 20%, full to 40%, x0.9 to 60%, x0.7 to 80%, x0.6 above; 1.8/1.5/1.2 are full to 40%, then x0.9, x0.7, x0.6; 1.0/0.8/0.7/0.5 are flat; 0.3 becomes -0.9 above 40%; 0 above 80% eliminates the team (payout 0).
* Payout = rounded sum (half up, matching the original JavaScript; verified identical on 5,000 random allocations). The payout becomes the new balance.
* After rounds 1 to 3 a 30-minute wait starts (enforced only while the organizer setting is on).
* Up to 20 teams per industry, reserved atomically.

## 5. API (`api/index.py`)

All JSON responses are `no-store` unless noted. Bodies are limited to 64 KB. Database outages return a friendly 503.

### Public

| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | Database ping |
| GET | `/api/leaderboard` | Team, industry, round, balance, eliminated. Cached 3 s |
| GET | `/api/industry-capacity` | Seats per industry. Cached 3 s |
| POST | `/api/team/connect` | `{teamId, pin}`. Creates the team on first sign-in. Returns `{token, state}` |

### Team (header `Authorization: Team <token>`)

| Method | Route | Notes |
|---|---|---|
| GET | `/api/team/state` | Full player state plus settings and server time; doubles as the heartbeat |
| POST | `/api/team/industry` | `{industry}`; locks it, respects the 20-team cap |
| POST | `/api/team/flash/open` | Starts the flash for the current round |
| POST | `/api/team/flash/close` | Refused while the timer is running; marks the flash complete |
| GET | `/api/team/flash/page/{n}?round=` | WebP page; only for the current round's open or finished flash, or earlier rounds |
| GET | `/api/team/dataset` | Current round's file; only after the flash is finished; marks it downloaded |
| POST | `/api/team/submit` | `{round, allocations}`; validated and scored on the server, once per round |
| POST | `/api/team/advance` | `{round}`; opens the next round when allowed; safe to repeat |
| POST | `/api/team/activity` | `{kind, detail}`; integrity events only (allowlist), max 30 per minute per team |

### Organizer (header `X-Console-Key: <console path>`; all but login also need `Authorization: Bearer <token>`)

| Method | Route | Notes |
|---|---|---|
| POST | `/api/admin/login` | `{password}`; 8-hour token |
| GET | `/api/admin/dashboard?kind=&team=&industry=` | Teams, alerts/activity (latest 150), alert count for 10 min, settings, seats |
| PATCH | `/api/admin/settings` | `{flashTimer?, roundWait?}` |
| PATCH | `/api/admin/team-balance` | `{teamKey, companyValue}` |
| POST | `/api/admin/team-reset-pin` | `{teamKey}`; clears the PIN and signs out all of the team's devices |

Without the right console key every organizer route answers 404.

### Pages

| Route | Notes |
|---|---|
| `/<ADMIN_CONSOLE_PATH>/` (+ `admin.js`, `admin.css`) | Organizer console; optional IP allowlist; `noindex` |
| anything else not in `public/` | 404 page |

## 6. Database collections

| Collection | Key | Notes |
|---|---|---|
| `data_tycoon_teams` | normalized team name | Progress, balance, history, PIN hash (PBKDF2-SHA256, per-team salt and iteration count), session version |
| `data_tycoon_activities` | ObjectId | Integrity alerts and game events; indexed by team, kind, industry; auto-deleted after 14 days |
| `data_tycoon_settings` | `flash-timer`, `round-wait` | `{enabled, changedAt}` |
| `data_tycoon_industry_capacity` | industry | Seat counters used for atomic reservation and for display |
| `data_tycoon_rate_limits` | ObjectId | Failed sign-in records; auto-deleted after 15 minutes |

Older team records written by the previous version are read correctly (history, flags and active flash are converted on the fly), and their PINs still work.

## 7. Organizer console (original design restored)

* Stats: teams, online now (seen in the last 30 s), integrity alerts in the last 10 minutes, combined balance.
* Controls: flash timer (on = five-minute lock, turning it on restarts the lock for open flashes), 30-minute round wait.
* Teams table: rank, name (with "PIN reset" tag), industry, progress, online status, balance, Set balance, Reset PIN. Filter by industry. Rows do not refresh while you are typing a balance.
* Alerts feed: filter by type (all alerts, screenshots, tab switches, all activity), industry and team; new alerts flash briefly. Refreshes every 3 s.

## 8. Security and integrity controls

**Server**
* Scoring, gating, timers and waits are enforced on the server; the browser cannot set its balance, round or history.
* The answer key, flashes, datasets and console are only under `api/`, which is never served as static content.
* Team PINs: PBKDF2-SHA256 with a random salt; hashing runs one at a time per process so a sign-in rush cannot stall the game; recent successful checks are remembered in memory using a server-keyed HMAC.
* One device per team: each sign-in revokes the previous device's token (it is told why).
* Signed tokens (HMAC-SHA256): team tokens last 24 h and are revoked by a new sign-in or a PIN reset; organizer tokens last 8 h; a team token is never accepted as an organizer token.
* Rate limits stored in MongoDB (shared across instances): 10 wrong PINs per team per 5 minutes, 30 per IP per minute; organizer 8 per IP per minute and 40 overall per 5 minutes.
* Console hidden behind a secret path (`ADMIN_CONSOLE_PATH`, or derived from the session secret so it never appears in this public repo; print it with `scripts/console_url.py`), optional IP allowlist, `noindex`.
* Headers on every response: strict Content-Security-Policy (no third-party hosts), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP.

**Browser, while a flash is open (`guard.js`)**
* Print Screen detected on key press and key release (Windows only sends the release).
* Win+Shift (Windows Snipping Tool) and Cmd+Shift (macOS 3/4/5) blank the flash as soon as the two keys are held, before the capture key, and alert the organizers.
* Switching tab, app or window, opening a screenshot tool, or minimizing: the flash is blanked, the organizers are alerted, and on return a "You left the flash" card shows how long the player was away (a return event is logged too).
* Pointer leaving through the window edge blanks the flash until it returns (no alert).
* Print, save, view-source, developer-tools shortcuts, copy, select, drag and right-click are blocked; printing shows nothing.
* Every page carries a watermark with the team name and time, so photos and screenshots are traceable.
* The rest of the app is `inert` behind the flash, and reloading reopens a locked flash.

**Limits (cannot be solved by any website):** a phone camera, a second device, phone screenshot buttons, screen recorders, and some Linux/ChromeOS capture tools never reach the browser. The watermark and in-room supervision cover those.
