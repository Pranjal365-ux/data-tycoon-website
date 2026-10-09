from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import shutil
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
STORE_LOCK = threading.RLock()
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
LAST_SEEN: dict[str, float] = {}


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


load_dotenv()
legacy_data_path = ROOT / "server-data.json"
configured_data_path = os.environ.get("DATA_PATH")
DATA_PATH = Path(configured_data_path).resolve() if configured_data_path else (ROOT.parent / ".data-tycoon" / "server-data.json").resolve()
if not configured_data_path and not DATA_PATH.exists() and legacy_data_path.exists():
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(legacy_data_path, DATA_PATH)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SESSION_SECRET = os.environ.get("ADMIN_SESSION_SECRET", "") or ADMIN_PASSWORD
PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "127.0.0.1")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_store() -> dict:
    if not DATA_PATH.exists():
        return {"teams": {}, "activities": []}
    try:
        data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("store root must be an object")
        data.setdefault("teams", {})
        data.setdefault("activities", [])
        return data
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"Could not read {DATA_PATH.name}: {error}") from error


def write_store(data: dict) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = DATA_PATH.with_suffix(".json.tmp")
    temporary_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary_path, DATA_PATH)


def clean_text(value, limit: int = 160) -> str:
    return " ".join(str(value or "").strip().split())[:limit]


def team_key(team_id: str) -> str:
    return clean_text(team_id, 80).casefold()


def append_activity(data: dict, team_id: str, kind: str, detail: str, actor: str = "team") -> None:
    data["activities"].append({
        "id": secrets.token_hex(8),
        "teamId": clean_text(team_id, 80),
        "kind": clean_text(kind, 48),
        "detail": clean_text(detail, 220),
        "actor": actor,
        "timestamp": utc_now(),
    })
    data["activities"] = data["activities"][-1500:]


def issue_token() -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"exp": int(time.time()) + 8 * 60 * 60, "nonce": secrets.token_hex(8)}).encode()).decode().rstrip("=")
    signature = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return payload + "." + base64.urlsafe_b64encode(signature).decode().rstrip("=")


def token_is_valid(token: str) -> bool:
    if not SESSION_SECRET or "." not in token:
        return False
    payload, supplied_signature = token.split(".", 1)
    expected = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    try:
        supplied = base64.urlsafe_b64decode(supplied_signature + "=" * (-len(supplied_signature) % 4))
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, json.JSONDecodeError):
        return False
    return hmac.compare_digest(expected, supplied) and claims.get("exp", 0) > time.time()


class DataTycoonHandler(SimpleHTTPRequestHandler):
    server_version = "DataTycoon/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string, *args):
        if self.path.startswith("/api/"):
            super().log_message(format_string, *args)

    def end_headers(self):
        origin = self.headers.get("Origin", "")
        if ALLOWED_ORIGIN == "*":
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin in [item.strip() for item in ALLOWED_ORIGIN.split(",")]:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: int, payload: dict | list):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 1_000_000:
            raise ValueError("Request body is too large")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw or b"{}")
        if not isinstance(data, dict):
            raise ValueError("Request body must be a JSON object")
        return data

    def admin_authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if token_is_valid(token):
            return True
        self.send_json(401, {"error": "Organizer sign-in required."})
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        decoded_path = unquote(path)
        if any(part.startswith(".") for part in decoded_path.split("/") if part):
            return self.send_json(404, {"error": "Not found."})
        if decoded_path in {"/server-data.json", "/server-data.json.tmp"}:
            return self.send_json(404, {"error": "Not found."})
        if path == "/admin":
            self.path = "/admin.html"
            return super().do_GET()
        if path == "/api/health":
            return self.send_json(200, {"ok": True, "service": "data-tycoon"})
        if path.startswith("/api/team/"):
            requested_id = unquote(path[len("/api/team/"):])
            with STORE_LOCK:
                team = read_store()["teams"].get(team_key(requested_id))
            if not team:
                return self.send_json(404, {"error": "Team not found."})
            return self.send_json(200, {
                "teamId": team["teamId"],
                "companyValue": team["companyValue"],
                "moneyRevision": team.get("moneyRevision", 0),
            })
        if path == "/api/leaderboard":
            with STORE_LOCK:
                teams = list(read_store()["teams"].values())
            leaderboard = [{
                "teamId": team.get("teamId", ""),
                "industry": team.get("industry", ""),
                "round": team.get("round", 1),
                "companyValue": team.get("companyValue", 0),
                "isEliminated": bool(team.get("isEliminated")),
            } for team in teams]
            leaderboard.sort(key=lambda team: (-float(team.get("companyValue", 0)), team["teamId"].casefold()))
            return self.send_json(200, leaderboard)
        if path == "/api/admin/teams":
            if not self.admin_authorized():
                return
            with STORE_LOCK:
                data = read_store()
            now = time.time()
            teams = [
                public_team(team) | {"online": now - max(team.get("lastSeenEpoch", 0), LAST_SEEN.get(team_key(team["teamId"]), 0)) < 20}
                for team in data["teams"].values()
            ]
            teams.sort(key=lambda team: (-float(team.get("companyValue", 0)), team.get("teamId", "").casefold()))
            return self.send_json(200, teams)
        if path == "/api/admin/activities":
            if not self.admin_authorized():
                return
            query = parse_qs(parsed.query)
            filter_team = query.get("teamId", [""])[0].casefold()
            with STORE_LOCK:
                activities = list(read_store()["activities"])
            if filter_team:
                activities = [item for item in activities if item.get("teamId", "").casefold() == filter_team]
            return self.send_json(200, activities[-250:][::-1])
        return super().do_GET()

    def do_HEAD(self):
        path = unquote(urlparse(self.path).path)
        if any(part.startswith(".") for part in path.split("/") if part) or path.startswith("/server-data.json"):
            self.send_error(404)
            return
        return super().do_HEAD()

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError) as error:
            return self.send_json(400, {"error": str(error)})

        if path == "/api/admin/login":
            ip = self.client_address[0]
            now = time.time()
            attempts = [timestamp for timestamp in LOGIN_ATTEMPTS.get(ip, []) if now - timestamp < 60]
            if len(attempts) >= 8:
                LOGIN_ATTEMPTS[ip] = attempts
                return self.send_json(429, {"error": "Too many sign-in attempts. Wait a minute and try again."})
            supplied = str(body.get("password", ""))
            if not ADMIN_PASSWORD:
                return self.send_json(503, {"error": "Organizer access is not configured. Set ADMIN_PASSWORD in .env and restart the server."})
            if not hmac.compare_digest(supplied.encode(), ADMIN_PASSWORD.encode()):
                attempts.append(now)
                LOGIN_ATTEMPTS[ip] = attempts
                return self.send_json(401, {"error": "Incorrect organizer password."})
            LOGIN_ATTEMPTS.pop(ip, None)
            return self.send_json(200, {"token": issue_token(), "expiresIn": 8 * 60 * 60})

        if path == "/api/team/sync":
            team_id = clean_text(body.get("teamId"), 80)
            if not team_id:
                return self.send_json(400, {"error": "A team name is required."})
            try:
                round_number = max(1, min(4, int(body.get("round", 1))))
                balance = max(0, min(10**12, float(body.get("companyValue", 0))))
            except (TypeError, ValueError):
                return self.send_json(400, {"error": "Invalid team balance or round."})
            key = team_key(team_id)
            with STORE_LOCK:
                data = read_store()
                previous = data["teams"].get(key, {})
                incoming_history = body.get("history") if isinstance(body.get("history"), list) else []
                previous_rounds = {item.get("round") for item in previous.get("history", [])}
                has_new_result = any(item.get("round") not in previous_rounds for item in incoming_history if isinstance(item, dict))
                preserve_override = previous.get("adminOverride") and not has_new_result
                next_balance = previous.get("companyValue", balance) if preserve_override else balance
                revision = int(previous.get("moneyRevision", 0))
                team = {
                    **previous,
                    "teamId": team_id,
                    "industry": clean_text(previous.get("industry"), 80) or clean_text(body.get("industry"), 80),
                    "round": round_number,
                    "companyValue": next_balance,
                    "allocations": safe_allocations(body.get("allocations")),
                    "history": [{"round": item.get("round"), "finalPayout": item.get("finalPayout", item.get("newValue", 0)), "eliminated": bool(item.get("eliminated"))} for item in incoming_history if isinstance(item, dict)][-4:],
                    "page": clean_text(body.get("page"), 24),
                    "isEliminated": bool(body.get("isEliminated")),
                    "moneyRevision": revision,
                    "adminOverride": bool(preserve_override),
                    "updatedAt": utc_now(),
                    "lastSeenEpoch": time.time(),
                }
                data["teams"][key] = team
                LAST_SEEN[key] = team["lastSeenEpoch"]
                write_store(data)
            return self.send_json(200, {"team": public_team(team)})

        if path == "/api/team/activity":
            team_id = clean_text(body.get("teamId"), 80)
            kind = clean_text(body.get("kind"), 48)
            if not team_id or not kind:
                return self.send_json(400, {"error": "Team and activity type are required."})
            with STORE_LOCK:
                data = read_store()
                append_activity(data, team_id, kind, clean_text(body.get("detail"), 220))
                team = data["teams"].get(team_key(team_id))
                if team:
                    LAST_SEEN[team_key(team_id)] = time.time()
                write_store(data)
            return self.send_json(202, {"ok": True})

        if path == "/api/team/heartbeat":
            team_id = clean_text(body.get("teamId"), 80)
            if not team_id:
                return self.send_json(400, {"error": "A team name is required."})
            with STORE_LOCK:
                data = read_store()
                team = data["teams"].get(team_key(team_id))
                if team:
                    LAST_SEEN[team_key(team_id)] = time.time()
            return self.send_json(200, {"ok": True})

        return self.send_json(404, {"error": "API route not found."})

    def do_PATCH(self):
        prefix = "/api/admin/teams/"
        path = urlparse(self.path).path
        if not path.startswith(prefix) or not path.endswith("/money"):
            return self.send_json(404, {"error": "API route not found."})
        if not self.admin_authorized():
            return
        try:
            body = self.read_json()
            amount = float(body.get("companyValue"))
            if not (0 <= amount <= 10**12):
                raise ValueError("Money must be between ₹0 and ₹1,000,000,000,000.")
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            return self.send_json(400, {"error": str(error)})
        requested_id = unquote(path[len(prefix):-len("/money")])
        key = team_key(requested_id)
        with STORE_LOCK:
            data = read_store()
            team = data["teams"].get(key)
            if not team:
                return self.send_json(404, {"error": "Team not found."})
            old_amount = team["companyValue"]
            team["companyValue"] = round(amount)
            team["moneyRevision"] = int(team.get("moneyRevision", 0)) + 1
            team["adminOverride"] = True
            team["updatedAt"] = utc_now()
            append_activity(data, team["teamId"], "organizer-money-edit", f"Organizer changed balance from ₹{old_amount:,.0f} to ₹{team['companyValue']:,.0f}.", "organizer")
            write_store(data)
        return self.send_json(200, public_team(team))


def safe_allocations(value) -> dict:
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, amount in list(value.items())[:20]:
        try:
            number = float(amount)
            if 0 <= number <= 10**12:
                result[clean_text(key, 100)] = number
        except (TypeError, ValueError):
            continue
    return result


def public_team(team: dict) -> dict:
    return {key: value for key, value in team.items() if key not in {"adminOverride"}}


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), DataTycoonHandler)
    print(f"Data Tycoon web and API server: http://{HOST}:{PORT}")
    print("Organizer password: configured" if ADMIN_PASSWORD else "Organizer password: not configured; set ADMIN_PASSWORD in .env")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Data Tycoon server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
