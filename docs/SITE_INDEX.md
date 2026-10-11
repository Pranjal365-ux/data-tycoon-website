# Data Tycoon: Full Site Index

Reference map of every page, UI element, state field, API route, timer, storage key and security control in this repository. Line numbers refer to the commit this file was added on.

---

## 1. Architecture at a glance

| Layer | Production (Vercel) | Local development |
|---|---|---|
| Static site | `index.html` (player), `admin.html` (organizer), `src/*`, `data/*` served as static files | Same files served by `server.py` (`SimpleHTTPRequestHandler`) |
| API | `api/index.py`, one FastAPI function. `vercel.json` rewrites `/api/:path*` to `/api?route=:path*` | `server.py` on `127.0.0.1:8000`, routes under `/api/*` |
| Storage | MongoDB Atlas (`MONGODB_URI`, `MONGODB_DATABASE`, default `data_tycoon`) | JSON file at `../.data-tycoon/server-data.json` (or `DATA_PATH`) |
| Team auth | Team name + Access PIN, signed team token | **None** (no PIN, no token; legacy path) |
| Organizer auth | `ADMIN_PASSWORD`, signed 8h bearer token | Same scheme |

Frontend is plain ES modules, no build step, no framework. All rendering is string templates written into `#page` via `innerHTML`.

`apiBase()` (`src/app.js:106`) and `API_BASE` (`src/admin.js:1-5`): on localhost (any port except 3000) or `file:` the frontend calls `http://127.0.0.1:8000/api`; otherwise `${origin}/api`. `window.DATA_TYCOON_API_BASE = ""` in both HTML files, so the fallback is always used. `usesLegacyLocalApi()` (`app.js:114`) switches the player portal to the PIN-less local API.

Contributors in history: pranjal (initial game flow), Samar Nanda (anti-camera overlay, later deleted), Sana Patel (Vercel/Mongo backend, PINs, organizer controls), Shreyas B S (docs).

---

## 2. File inventory

| File | Role | Status |
|---|---|---|
| `index.html` | Player shell: utility bar, masthead, `#page`, footer, flash overlay | Live |
| `admin.html` | Organizer portal markup | Live |
| `src/app.js` (1285 lines) | Entire player game: state, rendering, scoring, flash lock, anti-cheat, sync | Live |
| `src/admin.js` (282 lines) | Organizer dashboard logic | Live |
| `src/flash-viewer.js` | Renders flash PDFs to `<canvas>` with pdf.js 6.4.299 from jsDelivr | Live |
| `src/data/events.js` | `EVENT_DURATION_MS` (5 min), 4 flash events pointing at `data/flashes/flash-N.pdf` | Live |
| `src/data/industries.js` | 5 industries (name, description, `departments`) | Live (`departments` unused) |
| `src/data/round-rules.js` | Parameters per industry, **payout ranking (answer key)**, `datasetFor()` | Live |
| `src/data/leaderboard.js` | localStorage leaderboard cache, sorting, rank lookup | Live |
| `src/styles.css` | Base newspaper theme, tokens, anti-cheat cover | Live (`?v=6`) |
| `src/editorial.css` | Masthead, utility bar, breaking strip, front page | Live (no version query) |
| `src/gameflow.css` | Phase bar, dashboard, chart, allocation table, flash overlay | Live (`?v=12`) |
| `src/security.css` | `@media print` hides everything | Live (`?v=3`) |
| `src/admin.css` | Organizer portal styles | Live (`?v=4`) |
| `src/minigame-ui.js`, `src/data/minigames.js`, `src/minigames.css` | Wordle / word search / anagram / sudoku per flash | **Dead code**, not imported or linked anywhere |
| `src/data/industry-datasets.js` | Sample "Nova Foods" style company data | **Dead code** |
| `api/index.py` (814 lines) | Production API | Live |
| `server.py` (581 lines) | Local web + API server | Local only |
| `vercel.json` | API rewrite only, no headers | Live |
| `requirements.txt` | `fastapi`, `pymongo` | Live |
| `.env.example` | `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `MONGODB_URI`, `MONGODB_DATABASE`, `ALLOWED_ORIGIN`, `HOST`, `PORT` | Template |
| `ADMIN_PORTAL.md` | Deploy/run guide | Partly stale (see section 12) |
| `.vscode/settings.json` | Live Server ignores the data store | Dev |
| `data/flashes/flash-1..4.pdf` | Round storyline flashes, about 16 to 18 MB each, 6 pages | Static, publicly fetchable |
| `data/round-datasets/flash1..4/*` | 20 datasets (5 industries x 4 rounds). Food flash 1 and 2 are `.xlsx`, everything else `.csv` | Static, publicly fetchable |

---

## 3. Player portal (`index.html` + `src/app.js`)

### 3.1 Static shell (`index.html`)

| Element | ID / class | Behavior |
|---|---|---|
| Utility bar | `.utility-bar` | Two labels plus **RETURN TO LOGIN** button `#returnToLogin` (`data-action="login"`), hidden on the login page |
| Masthead | `.masthead` | Meta line, "DT" seal, title link (`data-action="home"`, goes to login page), "SPECIAL EDITION" stamp, motto |
| Breaking strip | `.breaking-strip` | Static "NEWSROOM WIRE" text |
| Page body | `main#page` | All views are injected here by `render()` |
| Footer | `footer` | Event credit plus link to `./admin.html` |
| Flash overlay | `#newsOverlay` (`role="dialog"`, `aria-modal`) | `#flashNumber`, `#countdown`, `#eventDocument` (PDF canvas host), `#flashTimerNotice`, `#finishFlashButton` (`data-action="finish-flash"`, only shown when timer is off) |

### 3.2 Navigation

* `state.page` is one of `login`, `industries`, `game`, `results`, `leaderboard`.
* Phase bar (`renderPhaseBar`, `app.js:460`), hidden on login: `01 CHOOSE INDUSTRY` (plain span, not clickable), `02 ROUND DASHBOARD`, `03 ROUND RESULTS`, `LEADERBOARD` (buttons, `data-action="nav"`). Right side shows `<INDUSTRY> DESK` or `NO INDUSTRY CHOSEN`.
* `showPage(id)` (`app.js:438`) redirects `industries` to `game` once an industry is locked, saves, renders, scrolls to top, and refreshes the leaderboard when opened.
* "Home" and "Return to login" both just show the login page; they do **not** clear the team session or token.

### 3.3 Views

**Login (`renderLogin`, `app.js:516`)**
* Left: "WELCOME, ANALYSTS." copy, event rules (start ₹1,000,000; ₹250,000 bonus before Flash 2 and Flash 3; ₹1,000 minimum per parameter), monitoring notice about screenshot signals.
* Form `#loginForm`: `#teamId` (required, prefilled), `#pin` (password, 4 to 64 chars), two help lines, optional `#teamConnectionError` alert, submit **ENTER THE NEWSROOM**.
* Submit handler (`app.js:1135`): blank team name falls back to `"Team Alpha"`. Calls `loadRemoteTeam()` which POSTs `/team/connect` (prod) or GETs `/team/{id}` (local). Stores the token, merges server state over any browser copy (server authoritative for progress maps; local `subsystemResults` kept), restores or clears the saved active flash, picks the resume page, logs `team-connected`.

**Industry selection (`renderIndustries`, `app.js:543`)**
* Selection strip with status text and **CONFIRM & PROCEED TO DASHBOARD** (`confirm-industry`), disabled until a pick is made, reads **INDUSTRY LOCKED** afterwards.
* Five cards (Food, Electronics, Travel and Auto, Pharma, Education): number, description, live seat count (`N of 20 seats remaining`, from `/industry-capacity` every 10 s while on this page), **CHOOSE THIS INDUSTRY** (`select-industry`) or **NO SEATS LEFT**.
* Confirm POSTs `/team/industry`; server reserves a seat atomically. Error shown via `state.industrySelectionError`.

**Round dashboard (`renderGame`, `app.js:590`)**
Guard states: no industry (link back), eliminated (message + leaderboard link).
Sections in order:
1. Live label `ROUND 0N OF 04` and heading.
2. Market tape: round budget, leaderboard rank (`#n of N teams`), round progress, industry.
3. **How to play** card: bonus or carry-forward line, 4 numbered steps.
4. **Mandatory storyline flash** card with **OPEN FLASH** (`open-flash`).
5. **Dataset** card with **DOWNLOAD ROUND N DATASET (CSV/XLSX)** (`download-dataset`), disabled until the flash is complete; becomes "DATASET DOWNLOADED · DOWNLOAD AGAIN".
6. **Net capital trend** SVG chart (`companyValueChart`, `app.js:477`): start point plus one point per submitted round, last value, % change arrow, colored by trend.
7. **Investment allocation desk**: 10 rows (5 common, 5 industry-specific), number inputs `#alloc-0..9` (`data-allocation`, min 1000, max budget, step 1), disabled until flash done + dataset downloaded + round not yet submitted. Totals box: required budget, `#totalInvestedAmount`, `#remainingCashAmount`. Status line `#allocationTotal` (valid/invalid). **LOCK & SUBMIT ROUND N** `#submitAllocation` (`submit-round`).

**Results (`renderResults`, `app.js:675`)**
* Heading (INVESTMENT RESULTS or TEAM ELIMINATED), chart, final payout, net profit, bonus line, disqualification note, current rank.
* Table: parameter, allocation %, invested, amount returned.
* Footer action: eliminated: leaderboard button; rounds 1 to 3: `#roundWaitCountdown` + **PROCEED TO ROUND N+1** (`next-round`), locked while the 30 min wait runs; round 4: final leaderboard button.

**Leaderboard (`renderLeaderboard`, `app.js:740`)**
* Table: medal rank, team name (with "(YOU)" highlight), industry, round reached, net capital.
* Buttons: back to dashboard, **REFRESH RANKINGS** (`refresh-leaderboard`).
* Data comes from `/leaderboard` and is cached in localStorage; refreshed every 15 s only while this page is open.

### 3.4 Click actions (`data-action`, delegated in `app.js:1054`)

`home`, `login`, `nav` (+`data-page`), `select-industry`, `confirm-industry`, `open-flash`, `finish-flash`, `download-dataset`, `submit-round`, `next-round`, `refresh-leaderboard`.

### 3.5 Game rules and scoring

* Budget per round: `roundBudget()` = current `companyValue` + ₹250,000 if round is 2 or 3 (`app.js:14-21`). Round 1 uses ₹1,000,000.
* Valid allocation: every parameter an integer of at least ₹1,000 and the total exactly equal to the budget (`allocationValid`, `app.js:795`).
* Gating per round: open flash, finish it (timer expiry or manual close), download dataset, then invest, then submit once.
* Multipliers (`round-rules.js`): for each industry and round, the 10 parameters are ranked; rank maps to base multiplier `[2.7, 1.8, 1.5, 1.2, 1, 0.8, 0.7, 0.5, 0.3, 0]`.
* Allocation bands (`computeEffectiveMultiplier`, `app.js:806`), by % of round budget:
  * 2.7: up to 20% x0.8, 20 to 40% full, 40 to 60% x0.9, 60 to 80% x0.7, over 80% x0.6
  * 1.8 / 1.5 / 1.2: up to 40% full, 40 to 60% x0.9, 60 to 80% x0.7, over 80% x0.6
  * 1.0 / 0.8 / 0.7 / 0.5: flat
  * 0.3 ("loss trap"): over 40% becomes **-0.9**
  * 0 ("zero trap"): over 80% **eliminates** the team (payout 0, `isEliminated`)
* Result: `finalPayout` (rounded sum) becomes the new `companyValue`; history entry stores allocations, per-parameter returns, budget, bonus, net profit, change %.
* After submitting rounds 1 to 3 (not eliminated), `roundWaitUntil` = now + 30 min unless the organizer has disabled the wait. Advancing calls `/team/advance-round`, which the server validates.
* `datasetFor(industry, round)` gives `./data/round-datasets/flash{round}/{slug}.{csv|xlsx}`.

### 3.6 Flash (storyline PDF) system

* `startEvent` (`app.js:971`) refreshes timer settings, writes `{id, startedAt, duration}` to `data-tycoon-active-event-v6-{team}`, logs `flash-started`, opens the overlay.
* `activeEvent()` (`app.js:884`) computes remaining time from `max(startedAt, flashTimer.changedAt)`. When the timer is on and time runs out, it marks the round's flash complete and logs `flash-completed`.
* Timer **off**: countdown shows "TIMER OFF" and **DONE READING** appears (`finishFlashManually`, `app.js:990`).
* While open: `#appRoot.inert = true`, body scroll locked, 200 ms tick while timed.
* Active flash is synced to the server and restored on sign-in, so reloading or another device cannot skip the lock.
* PDF rendering (`flash-viewer.js`): pdf.js loaded from `cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299`, pages lazily drawn to canvases (max 1.5x scale) with `IntersectionObserver`, no browser PDF toolbar, so no built-in save/print/download buttons.

### 3.7 Client state (`defaults`, `app.js:23`)

`page`, `teamId`, `industry`, `pendingIndustry`, `resumePage`, `round`, `scoringVersion` (2), `companyValue`, `valueEnteredAt` (microseconds, tie-break), `roundWaitUntil`, `moneyRevision`, `allocations`, `allocationRound`, `allocationBudget`, `allocationSetupVersion`, `history`, `flashCompletedRounds`, `datasetDownloadedRounds` (keyed `Industry-round`), `offlineBonusClaimed` (legacy, unused), `round2GrantApplied` (legacy, unused). Also set at runtime: `isEliminated`, `industrySelectionError`.

### 3.8 Browser storage keys

| Key | Storage | Content |
|---|---|---|
| `data-tycoon-game-v5` | localStorage | Last active game state |
| `data-tycoon-team-{slug}` | localStorage | Per-team state copy |
| `data-tycoon-active-event-v6-{slug}` | localStorage | Currently open flash |
| `data-tycoon-team-token-{normalized name}` | localStorage | Team session token (30 days) |
| `data-tycoon-active-team` | localStorage | Slug of last signed-in team |
| `data-tycoon-leaderboard-v2` | localStorage | Cached leaderboard |
| `data-tycoon-puzzle-*` | localStorage | Dead minigame code only |
| `data-tycoon-organizer-session` | sessionStorage | Organizer bearer token (8 h) |

### 3.9 Polling and timers (player)

| Interval | Function | Condition |
|---|---|---|
| 180 ms debounce | `scheduleTeamSync` POST `/team/sync` | Any save; retries every 5 s on failure |
| 250 ms debounce | allocation persist | While typing allocations |
| 200 ms | `syncEventOverlay` | Flash open and timer on |
| 1 s | `syncRoundWaitUI` | Always (no-op off results page) |
| 5 s | `/settings/round-wait` | Always |
| 5 s | `/settings/flash-timer` | Only while a flash is saved as open |
| 8 s | `/team/{id}/balance` (organizer edits) | Signed in |
| 10 s | `/industry-capacity` | On industries page |
| 15 s | `/team/heartbeat` | Signed in |
| 15 s | `/leaderboard` | On leaderboard page |

### 3.10 Activity kinds sent by the player

`team-connected`, `flash-started`, `flash-completed`, `dataset-downloaded`, `round-submitted`, `round-opened`, `organizer-balance-applied`, `screenshot-shortcut`, `clipboard-shortcut`. Server adds `organizer-money-edit`. The organizer feed only displays `screenshot-shortcut`.

---

## 4. Organizer portal (`admin.html` + `src/admin.js`)

### 4.1 Elements

| Element | ID | Behavior |
|---|---|---|
| Header brand | `.brand` | Link back to player site |
| Connection pill | `#connectionState` | CONNECTING, API READY, API OFFLINE, LIVE, RECONNECTING |
| Login form | `#loginPanel`, `#adminLoginForm`, `#adminPassword`, `#loginError` | POST `/admin/login`; token saved to sessionStorage; password field cleared |
| Sign out | `#logoutButton` | Clears token, stops polling |
| Integrity note | `.integrity-note` | Explains what screenshot signals can and cannot detect |
| Flash timer control | `#flashTimerStatus`, `#flashTimerDescription`, `#flashTimerToggle` | PATCH `/admin/settings/flash-timer`. Server default is **off** |
| Round wait control | `#roundWaitStatus`, `#roundWaitDescription`, `#roundWaitToggle` | PATCH `/admin/settings/round-wait`. Default **on**; turning off zeroes every team's `roundWaitUntil` |
| Stats | `#teamCount`, `#onlineCount`, `#signalCount` (screenshot signals in last 10 min), `#combinedBalance` | From dashboard payload |
| Teams table | `#industryFilter` (client-side filter, shows seats left), `#teamsBody`, `#refreshButton` | Columns: #, team, industry, round (or Eliminated), balance, ONLINE/OFFLINE (seen within 45 s), **SET BALANCE** form |
| Balance form | `form.money-form[data-team]` | PATCH `/admin/teams/{id}/money`; table re-render is skipped while an input has focus |
| Activity feed | `#activityIndustryFilter`, `#activityFilter` (server-side filters), `#activityFeed` | Latest 100 screenshot signals |
| Messages | `#dashboardError` | Errors and confirmation text |

### 4.2 Behavior

* Single endpoint poll: `GET /admin/dashboard` every **2 s** (setTimeout chain) returns teams, activities, both settings and industry capacity.
* Snapshots (`lastTeamsSnapshot`, `lastActivitiesSnapshot`) avoid needless DOM rewrites.
* Any 401 while holding a token signs the organizer out.
* Organizer balance edit sets `adminOverride` and bumps `moneyRevision`; the player picks it up within 8 s. The override sticks until the team submits a new round result.

---

## 5. Production API (`api/index.py`)

All responses `Cache-Control: no-store`. OpenAPI/docs disabled. Request bodies capped at 1 MB and must be JSON objects. Generic 500 handler hides exceptions.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| OPTIONS | any | none | 204, allows GET/POST/PATCH, `Content-Type, Authorization`. No `Access-Control-Allow-Origin` is sent, so cross-origin calls are effectively blocked |
| POST | `team/connect` | none, rate limited 8 failures/min/IP | Create team (sets PIN) or verify PIN; migrates pre-PIN teams once; returns team token + team |
| GET | `health` | none | Mongo ping |
| GET | `settings/flash-timer` | none | `{enabled, changedAt}` (default off) |
| GET | `settings/round-wait` | none | `{enabled, changedAt}` (default on) |
| POST | `admin/login` | rate limited 8 failures/min/IP | Constant-time password check, returns 8 h token |
| GET | `team/{id}/balance` | team token | `companyValue`, `valueEnteredAt`, `moneyRevision` |
| GET | `team/{id}` | team token | Team record minus `adminOverride`, `pinSalt`, `pinHash` |
| GET | `leaderboard` | none | All teams: id, industry, round, value, `valueEnteredAt`, `isEliminated`; sorted value desc, earliest entry, name |
| GET | `admin/dashboard` | admin | Teams (+online), screenshot activities (filters `teamId`, `industry`, limit 100), settings, capacity |
| GET | `admin/teams` | admin | Teams only (unused by current UI) |
| GET | `admin/activities` | admin | Screenshot activities, limit 250 (unused by current UI) |
| GET | `industry-capacity` | none | Per industry: capacity 20, assigned, remaining |
| POST | `team/sync` | team token | Upsert team snapshot (see 5.2) |
| POST | `team/industry` | team token | Atomic seat reservation, industry lock |
| POST | `team/advance-round` | team token | Server-checked round advance with 30 min wait |
| POST | `team/activity` | team token | Append activity, update last seen |
| POST | `team/heartbeat` | team token | Update last seen |
| PATCH | `admin/settings/flash-timer` | admin | Toggle; `changedAt` updates only on real change |
| PATCH | `admin/settings/round-wait` | admin | Toggle; disabling clears all waits |
| PATCH | `admin/teams/{id}/money` | admin | Set balance 0 to 10^12, logs `organizer-money-edit` |

### 5.1 MongoDB collections

| Collection | `_id` | Notes |
|---|---|---|
| `data_tycoon_teams` | `teamKey` (casefolded, whitespace-normalized, max 80 chars) | Index `leaderboard_value_first` (companyValue desc, valueEnteredAt asc, teamId) |
| `data_tycoon_activities` | ObjectId | Indexes on (teamKey, _id desc) and `activity_kind_recent` (kind, _id desc). Pruned to latest 1500 every 100 writes per instance |
| `data_tycoon_settings` | `flash-timer`, `round-wait` | `{enabled, changedAt}` |
| `data_tycoon_industry_capacity` | industry name | `{count}` counter for atomic seat reservation |

### 5.2 `team/sync` server rules

* Round clamped 1 to 4. Moving forward is rejected unless it is exactly +1, the previous round has a history entry, and (when wait is on) a wait was set and has passed.
* `industry` is never taken from the client; it comes only from `team/industry`.
* `moneyRevision` is preserved from the server. If `adminOverride` is set and no new round result arrives, the server keeps the organizer's balance.
* `valueEnteredAt` is reset when the balance changes (tie-break: earlier wins).
* A new history round starts the 30 min wait server side.
* Sanitizers: `safe_allocations` (max 20 keys, finite, 0 to 10^12), `safe_boolean_map` (max 20), `safe_active_flash` (only `flash-1..4`, duration up to 300000), history kept to last 4 items.

---

## 6. Local server (`server.py`) differences

* Loads `.env` itself. Default CORS `Access-Control-Allow-Origin: *` unless `ALLOWED_ORIGIN` is set. Adds `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.
* Refuses dotfile paths (`.env`, `.git`) and `server-data.json` on GET and HEAD. `/admin` maps to `admin.html`.
* **No team authentication at all**: no `team/connect`, no PIN, no token checks on team routes.
* `team/sync` stores only `{round, finalPayout, eliminated}` per history item and does not persist `flashCompletedRounds`, `datasetDownloadedRounds` or `activeFlash`, so resume behaves differently from production.
* Heartbeats update an in-memory `LAST_SEEN` map only. Online window: 20 s on `admin/teams`, 45 s on `admin/dashboard`.
* Seat reservation is a count under a process lock (fine for one process).

---

## 7. Security and integrity controls (as implemented)

### 7.1 Authentication and sessions
* Team PINs: PBKDF2-HMAC-SHA256, 260,000 iterations, 16-byte random salt, constant-time compare. Raw PIN never stored; hash/salt stripped from every response.
* Team tokens: HMAC-SHA256 signed, `scope: "team"`, bound to `teamKey`, 30 day expiry. Sent as `Authorization: Team <token>`.
* Organizer tokens: HMAC-SHA256 signed, 8 h expiry, rejected if `scope == "team"` so a team token cannot act as admin. Sent as `Authorization: Bearer <token>`.
* Signing secret: `ADMIN_SESSION_SECRET`, falling back to `ADMIN_PASSWORD`.
* Login rate limiting: 8 failed attempts per IP per minute, separately for teams and organizers (in-memory).
* Concurrency: duplicate first sign-ins resolved via `DuplicateKeyError`; seat reservation via conditional `$inc`; round advance via filtered `find_one_and_update`.

### 7.2 Anti-cheat in the browser (`app.js:1002-1052`, CSS)
* Always blocked (capture phase): copy, cut, paste, context menu, text selection start, drag start, Ctrl/Cmd+C/V/X, Ctrl+Insert, Shift+Insert (logged as `clipboard-shortcut`).
* Always blocked: Ctrl/Cmd+P, Ctrl/Cmd+S.
* Screenshot shortcuts (PrintScreen, Ctrl/Cmd+Shift+S/3/4/5) prevented and, during a flash, reported as `screenshot-shortcut`.
* Tab hidden during a flash: `body.anti-cheat-cover` blacks out the page with "RETURN TO THE DATA TYCOON TAB".
* `@media print` hides the whole document (`security.css`).
* Flash rendered to canvas, app root made `inert`, timer state persisted server side.
* `user-select: none` on the flash document.

### 7.3 Output safety
* All dynamic text goes through `esc()` / `escapeHtml()` before being placed in templates.
* Text inputs trimmed and length-capped server side via `clean_text`.

---

## 8. Known gaps and risks (observed, not yet changed)

Ranked roughly by impact on a live event.

1. **Answer key is shipped to the browser.** `src/data/round-rules.js` contains the full ranking for every industry and round. Anyone can open it from DevTools or the URL and know the optimal allocation before the event.
2. **Scores are computed on the client and trusted by the server.** `team/sync` accepts any `companyValue` (0 to 10^12), any `history`, and `isEliminated: false`, so a team with a valid token can set its own balance from the console. It can also send a lower `round` (rewinding is not rejected).
3. **Flash PDFs and datasets are public static files** at predictable paths (`data/flashes/flash-4.pdf`, `data/round-datasets/flash4/...`). The flash and download gates exist only in the UI.
4. Rate limiter is per serverless instance and keyed on the first `X-Forwarded-For` value; it resets on cold start.
5. `vercel.json` sets no security headers (no CSP, `X-Frame-Options`/`frame-ancestors`, `nosniff`, `Referrer-Policy`), so the portal can be framed.
6. Seat counter (`data_tycoon_industry_capacity`) and the displayed capacity (`count_documents`) are computed differently and can drift if teams are deleted or edited by hand.
7. Team token lives 30 days in localStorage with no revoke path; organizer cannot reset a team's PIN from the UI.
8. Global copy/paste and selection blocking also applies to the login form (cannot paste a PIN) and allocation inputs.
9. Players' `clipboard-shortcut` events are written to the database on every Ctrl+C but never displayed.
10. Client default `flashTimerSettings.enabled = true` while the server default is off; the UI corrects itself after the first settings fetch.
11. Results text for eliminated teams says "any round bonus is still credited", but eliminated teams can never play another round.
12. Local `server.py` has no team auth and uses `*` CORS; fine for localhost, unsafe if exposed.

---

## 9. Visual system

* Tokens (`styles.css :root`): `--paper #f5edda`, `--paper-dark #e9e1cf`, `--ink #171717`, `--muted #77705f`, `--red #8e211b`, `--green #23652c`, `--rule #b8ad98`.
* Fonts (Google Fonts): Playfair Display (headlines), Libre Baskerville (body serif), DM Mono (labels, numbers). Admin uses Arial plus DM Mono.
* Breakpoints: 460, 560, 620, 700, 800, 850 px (player); 700, 1050 px (admin).
* Many dashboard and results styles are inline `style=""` attributes inside `app.js` templates rather than classes.
* Cache-busting query strings to bump when editing: `styles.css?v=6`, `gameflow.css?v=12`, `security.css?v=3`, `app.js?v=37`, `admin.css?v=4`, `admin.js?v=9`. `editorial.css` has none.

---

## 10. Content data

* Industries and their 10 parameters: 5 common (R&D & Innovation, Marketing & Sales, Supply Chain & Logistics, Technology & Digitalization, Workforce & Talent) plus 5 industry-specific (`round-rules.js:9-15`).
* Datasets: about 500 to 600 rows each, monthly or weekly time periods, column names vary per industry and round. Food flash 1/2 are Excel workbooks (`Food_Dataset`, `Food_Weekly_Dataset`).
* Flashes: 4 PDFs, one per round.

---

## 11. Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | both servers | Organizer login, fallback signing secret |
| `ADMIN_SESSION_SECRET` | both servers | Token signing secret |
| `MONGODB_URI` | `api/index.py` | Atlas connection |
| `MONGODB_DATABASE` | `api/index.py` | Database name (default `data_tycoon`) |
| `DATA_PATH` | `server.py` | JSON store location |
| `ALLOWED_ORIGIN` | `server.py` | CORS allowlist |
| `HOST`, `PORT` | `server.py` | Bind address |

---

## 12. Documentation drift

* `ADMIN_PORTAL.md` says the dashboard refreshes every five seconds; code and `admin.html` use two seconds.
* `ADMIN_PORTAL.md` mentions "Vercel PostgreSQL"; the backend is MongoDB.
* `ADMIN_PORTAL.md` ends with a stray `hiya` line.
* `ADMIN_PORTAL.md` says the activity feed shows browser focus changes; the feed now shows only screenshot signals.
