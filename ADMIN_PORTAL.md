# Organizer portal

The organizer portal is available at `/admin.html`. Team balances, leaderboard entries, and browser activity signals are shared through the API.

## Deploy on Vercel

The Vercel deployment uses the Python API in `api/index.py` and MongoDB Atlas. The existing `server.py` and local JSON store remain for local development only; data entered on localhost does not automatically appear in the production database.

1. Create a MongoDB Atlas cluster, database user, and copy the Python driver connection string.
2. In **Settings → Environment Variables**, ensure these variables are set for **Production**:
   - `ADMIN_PASSWORD`: the organizer login password.
   - `ADMIN_SESSION_SECRET`: a separate long random secret (recommended; if omitted, the API uses `ADMIN_PASSWORD` as the signing secret).
   - `MONGODB_URI`: the Atlas connection string, with the database user's password substituted for the placeholder.
   - `MONGODB_DATABASE`: the database name, such as `data_tycoon`.
3. Confirm the project’s Root Directory points to this website folder/repository root, where `vercel.json` and `requirements.txt` are located.
4. Redeploy the Production deployment after changing environment variables.
5. Open `https://<your-domain>/api/health`. A working setup returns `{"ok":true,"service":"data-tycoon"}`. If it returns 503, check `MONGODB_URI`, Atlas network access, and database user credentials.
6. Open `https://<your-domain>/admin.html` and sign in with the exact `ADMIN_PASSWORD` value. If you changed it, redeploy again and refresh the page.

Vercel environment changes apply to new deployments, not deployments that are already running. MongoDB collections and indexes are created automatically on the first API request. Keep the password, session secret, and connection string private; do not put them in frontend JavaScript or commit `.env`.

## Run locally

1. Copy `.env.example` to `.env` and set a private `ADMIN_PASSWORD` plus a different random `ADMIN_SESSION_SECRET`.
2. Stop any other server already using port 8000.
3. From this folder run `python server.py`.
4. Open `http://127.0.0.1:8000/admin.html` and sign in with the configured organizer password.

The local Python server saves its JSON store in the workspace sibling folder `.data-tycoon/server-data.json` by default, outside the served website so Live Server does not reload when game data changes. Set `DATA_PATH` in `.env` to choose another persistent location. Local JSON data and Vercel PostgreSQL data are separate.

The dashboard polls every two seconds. Team pages send a balance/game snapshot after changes and a five-second heartbeat. Organizer balance edits increment a revision that active team pages poll and apply. The activity log stores browser-reported signals such as window focus changes and detected Print Screen shortcuts. Browser APIs cannot detect every operating-system screenshot method. The app does not upload screen, camera, or audio content.

Team names are entered by participants and are not identity-verified by this portal. Activity signals are indicators for organizer review, not proof of misconduct.
