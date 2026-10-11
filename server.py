"""Run Data Tycoon locally (or on any VM / container host) as one process.

Serves the player site from public/, the organizer console at the secret
ADMIN_CONSOLE_PATH, and the API, all from api/index.py. This is the same code
that runs on Vercel, so local behaviour matches production.

    python server.py

Settings come from environment variables or a .env file next to this script.
For local development you can run MongoDB with Docker:

    docker run -d --name data-tycoon-mongo -p 27017:27017 mongo:7
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def main() -> None:
    load_dotenv()
    os.environ.setdefault("MONGODB_URI", "mongodb://127.0.0.1:27017")
    os.environ["DATA_TYCOON_SERVE_STATIC"] = "1"
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    console = os.environ.get("ADMIN_CONSOLE_PATH", "").strip("/")
    print(f"Data Tycoon: http://{host}:{port}/")
    print(f"Organizer console: http://{host}:{port}/{console}/" if console else "Organizer console: disabled (set ADMIN_CONSOLE_PATH)")
    uvicorn.run("api.index:app", host=host, port=port, workers=int(os.environ.get("WEB_CONCURRENCY", "1")), proxy_headers=True, timeout_keep_alive=75, log_level="warning")


if __name__ == "__main__":
    main()
