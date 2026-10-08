# Organizer portal

The organizer portal is at `/admin.html` (or `/admin`). Team balances, leaderboard entries, and browser activity signals are shared through the Python server's JSON store. By default it is saved in the workspace sibling folder `.data-tycoon/server-data.json`, outside the served website so Live Server does not reload when game data changes. Set `DATA_PATH` in `.env` to choose another persistent location.

## Run locally

1. Copy `.env.example` to `.env` and set a private `ADMIN_PASSWORD` plus a different random `ADMIN_SESSION_SECRET`.
2. Stop any other server already using port 8000.
3. From this folder run `python server.py`.
4. Open `http://127.0.0.1:8000/admin.html` and sign in with the configured organizer password.

Keep the organizer password and `server-data.json` private. Do not commit `.env` or the shared data file. For a public event, deploy this Python server over HTTPS and set a restrictive `ALLOWED_ORIGIN`; a static-only host cannot provide shared live data or money edits. If the frontend and API are hosted separately, set `window.DATA_TYCOON_API_BASE` in both HTML files to the API origin plus `/api`.

The dashboard polls every two seconds. Team pages send a balance/game snapshot after changes and a five-second heartbeat. Organizer balance edits increment a revision that active team pages poll and apply. The activity log stores browser-reported signals such as window focus changes and detected Print Screen shortcuts. Browser APIs cannot detect every operating-system screenshot method. The app does not upload screen, camera, or audio content.

Team names are entered by participants and are not identity-verified by this portal. Activity signals are indicators for organizer review, not proof of misconduct.
