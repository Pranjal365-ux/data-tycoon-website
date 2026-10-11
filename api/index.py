"""Data Tycoon API and site server.

Runs unchanged on Vercel (as a single Python function, see vercel.json) and as
a long-running ASGI app (uvicorn/gunicorn, e.g. on Azure App Service, see
server.py and Dockerfile).

The server is the source of truth for every team: it scores rounds, gates the
flash and dataset for each round, enforces the flash timer and the round wait,
and serves private content (flash pages, datasets, organizer console) only to
authorized callers.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError, OperationFailure, PyMongoError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _rules as rules  # noqa: E402

API_DIR = Path(__file__).resolve().parent
PRIVATE_DIR = API_DIR / "_private"
PUBLIC_DIR = API_DIR.parent / "public"
FLASH_DIR = PRIVATE_DIR / "flashes"
DATASET_DIR = PRIVATE_DIR / "datasets"
CONSOLE_DIR = PRIVATE_DIR / "console"

TEAM_TOKEN_TTL = 24 * 60 * 60
ADMIN_TOKEN_TTL = 8 * 60 * 60
PIN_ITERATIONS = 60_000  # new PINs; online guessing is stopped by rate limits
LEGACY_PIN_ITERATIONS = 260_000
ONLINE_WINDOW_SECONDS = 30
LAST_SEEN_WRITE_INTERVAL = 10
SETTINGS_CACHE_SECONDS = 2
PUBLIC_CACHE_SECONDS = 3
FLASH_GRACE_MS = 2_000
ACTIVITY_LIMIT_PER_MINUTE = 30
ACTIVITY_RETENTION_DAYS = 14
ALERT_KINDS = {"screenshot-shortcut", "screenshot-suspected", "print-attempt", "devtools-shortcut", "tab-hidden", "window-blur"}
PLAYER_ACTIVITY_KINDS = ALERT_KINDS | {"focus-return"}
TEAM_NAME_PATTERN = re.compile(r"^[\w .,'&()+\-]{2,40}$", re.UNICODE)
CONSOLE_PATH_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,80}$")

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; "
        "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

_mongo_lock = threading.Lock()
_mongo_client: MongoClient | None = None
_indexes_ready = False
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


# ── Configuration ────────────────────────────────────────────────────────────

def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def session_secret() -> str:
    return env("ADMIN_SESSION_SECRET") or env("ADMIN_PASSWORD")


def derived_console_path(secret: str) -> str:
    """Secret-derived console path, so no URL needs to live in this public repo."""
    digest = hmac.new(secret.encode(), b"data-tycoon-organizer-console-v1", hashlib.sha256).hexdigest()
    return f"ops-{digest[:24]}"


def console_path() -> str:
    value = env("ADMIN_CONSOLE_PATH").strip("/")
    if value:
        return value if CONSOLE_PATH_PATTERN.match(value) else ""
    secret = session_secret()
    return derived_console_path(secret) if secret else ""


# ── Database ─────────────────────────────────────────────────────────────────

def db():
    global _mongo_client, _indexes_ready
    uri = env("MONGODB_URI")
    if not uri:
        raise ApiError(503, "The event database is not configured.")
    with _mongo_lock:
        if _mongo_client is None:
            _mongo_client = MongoClient(
                uri,
                appname="data-tycoon",
                serverSelectionTimeoutMS=5000,
                connectTimeoutMS=5000,
                socketTimeoutMS=10000,
                # Serverless instances each hold their own pool, so keep them small there.
                maxPoolSize=int(env("MONGODB_MAX_POOL_SIZE", "5" if env("VERCEL") else "20")),
                maxIdleTimeMS=60000,
                retryWrites=True,
            )
        database = _mongo_client[env("MONGODB_DATABASE", "data_tycoon") or "data_tycoon"]
        if not _indexes_ready:
            ensure_indexes(database)
            _indexes_ready = True
    return database


SCHEMA_VERSION = 2
INDEXES = [
    # (collection, keys, options). Names match the ones the previous version
    # created, so existing production indexes are reused rather than conflicting.
    ("data_tycoon_teams", [("companyValue", DESCENDING), ("valueEnteredAt", ASCENDING), ("teamId", ASCENDING)], {"name": "leaderboard_value_first"}),
    ("data_tycoon_activities", [("teamKey", ASCENDING), ("_id", DESCENDING)], {}),
    ("data_tycoon_activities", [("kind", ASCENDING), ("_id", DESCENDING)], {"name": "activity_kind_recent"}),
    ("data_tycoon_activities", [("industry", ASCENDING), ("_id", DESCENDING)], {"name": "activity_industry_recent"}),
    ("data_tycoon_activities", [("createdAt", ASCENDING)], {"name": "activity_ttl", "expireAfterSeconds": ACTIVITY_RETENTION_DAYS * 86400}),
    ("data_tycoon_rate_limits", [("at", ASCENDING)], {"name": "rate_limit_ttl", "expireAfterSeconds": 900}),
    ("data_tycoon_rate_limits", [("key", ASCENDING), ("at", DESCENDING)], {"name": "rate_limit_key"}),
]


def ensure_indexes(database) -> None:
    """Create indexes once per database (one read on later cold starts)."""
    marker = database.data_tycoon_settings.find_one({"_id": "schema"}) or {}
    if int(marker.get("version", 0)) >= SCHEMA_VERSION:
        return
    for collection, keys, options in INDEXES:
        try:
            database[collection].create_index(keys, **options)
        except OperationFailure as error:
            # 85/86: an equivalent index already exists under another name or options.
            if error.code not in (85, 86):
                raise
    database.data_tycoon_settings.update_one({"_id": "schema"}, {"$set": {"version": SCHEMA_VERSION}}, upsert=True)


def cached(key: str, seconds: float, loader):
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < seconds:
            return hit[1]
    value = loader()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def invalidate(*keys: str) -> None:
    with _cache_lock:
        for key in keys:
            _cache.pop(key, None)


def now_ms() -> int:
    return int(time.time() * 1000)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def clean_text(value, limit: int = 160) -> str:
    text = "".join(ch for ch in str(value or "") if ch.isprintable())
    return " ".join(text.split())[:limit]


def team_key(team_id: str) -> str:
    return clean_text(team_id, 80).casefold()


def settings() -> dict:
    def load():
        rows = {row["_id"]: row for row in db().data_tycoon_settings.find({"_id": {"$in": ["flash-timer", "round-wait"]}})}
        flash = rows.get("flash-timer", {})
        wait = rows.get("round-wait", {})
        return {
            "flashTimer": {"enabled": bool(flash.get("enabled", False)), "changedAt": int(flash.get("changedAt", 0))},
            "roundWait": {"enabled": bool(wait.get("enabled", True)), "changedAt": int(wait.get("changedAt", 0))},
        }
    return cached("settings", SETTINGS_CACHE_SECONDS, load)


def industry_capacity() -> list[dict]:
    def load():
        database = db()
        counters = {row["_id"]: int(row.get("count", 0)) for row in database.data_tycoon_industry_capacity.find({})}
        for name in rules.INDUSTRIES:
            if name not in counters:
                count = database.data_tycoon_teams.count_documents({"industry": name})
                try:
                    database.data_tycoon_industry_capacity.insert_one({"_id": name, "count": count})
                    counters[name] = count
                except DuplicateKeyError:
                    counters[name] = int(database.data_tycoon_industry_capacity.find_one({"_id": name}).get("count", 0))
        return [
            {
                "industry": name,
                "description": rules.INDUSTRY_DESCRIPTIONS[name],
                "capacity": rules.INDUSTRY_CAPACITY,
                "assigned": counters[name],
                "remaining": max(0, rules.INDUSTRY_CAPACITY - counters[name]),
            }
            for name in rules.INDUSTRIES
        ]
    return cached("capacity", PUBLIC_CACHE_SECONDS, load)


def record_activity(team: dict, kind: str, detail: str, actor: str = "team") -> None:
    db().data_tycoon_activities.insert_one({
        "teamId": team.get("teamId", ""),
        "teamKey": team_key(team.get("teamId", "")),
        "industry": team.get("industry", ""),
        "round": int(team.get("round", 1) or 1),
        "kind": clean_text(kind, 48),
        "detail": clean_text(detail, 240),
        "actor": actor,
        "createdAt": utc_now(),
    })


# ── Request helpers ──────────────────────────────────────────────────────────

def client_ip(request: Request) -> str:
    candidates = [
        request.headers.get("x-vercel-forwarded-for", ""),
        request.headers.get("x-azure-clientip", ""),
        (request.headers.get("x-forwarded-for", "").split(",")[-1]),
        request.client.host if request.client else "",
    ]
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        if candidate.count(":") == 1 and "." in candidate:  # IPv4 with port (Azure)
            candidate = candidate.split(":", 1)[0]
        return candidate.strip("[]")
    return "unknown"


async def json_body(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > 64_000:
        raise ApiError(413, "Request body is too large.")
    try:
        value = json.loads(raw or b"{}")
    except json.JSONDecodeError as error:
        raise ApiError(400, "Request body must be valid JSON.") from error
    if not isinstance(value, dict):
        raise ApiError(400, "Request body must be a JSON object.")
    return value


def json_response(payload, status: int = 200, cache_seconds: int = 0) -> JSONResponse:
    headers = {"Cache-Control": f"public, max-age={cache_seconds}, s-maxage={cache_seconds}" if cache_seconds else "no-store"}
    return JSONResponse(payload, status_code=status, headers=headers)


def rate_limited(key: str, limit: int, window_seconds: int) -> bool:
    since = utc_now() - timedelta(seconds=window_seconds)
    return db().data_tycoon_rate_limits.count_documents({"key": key, "at": {"$gte": since}}, limit=limit) >= limit


def note_failure(*keys: str) -> None:
    at = utc_now()
    db().data_tycoon_rate_limits.insert_many([{"key": key, "at": at} for key in keys])


# ── Tokens ───────────────────────────────────────────────────────────────────

def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def sign_token(claims: dict) -> str:
    secret = session_secret()
    if not secret:
        raise ApiError(503, "Sign-in is not configured on the server.")
    payload = _b64(json.dumps({**claims, "nonce": secrets.token_hex(6)}, separators=(",", ":")).encode())
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return f"{payload}.{_b64(signature)}"


def read_token(token: str) -> dict | None:
    secret = session_secret()
    if not secret or token.count(".") != 1:
        return None
    payload, signature = token.split(".", 1)
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, _unb64(signature)):
            return None
        claims = json.loads(_unb64(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(claims, dict) or claims.get("exp", 0) <= time.time():
        return None
    return claims


def bearer(request: Request, scheme: str) -> str:
    header = request.headers.get("authorization", "")
    prefix = f"{scheme} "
    return header[len(prefix):].strip() if header.startswith(prefix) else ""


def require_team(request: Request) -> dict:
    claims = read_token(bearer(request, "Team"))
    if not claims or claims.get("scope") != "team":
        raise ApiError(401, "Your team session has ended. Sign in again with your team PIN.")
    team = db().data_tycoon_teams.find_one({"_id": claims.get("teamKey")})
    if not team:
        raise ApiError(401, "Your team session has ended. Sign in again with your team PIN.")
    if int(team.get("sessionVersion", 0)) != int(claims.get("sv", -1)):
        raise ApiError(401, "This device was signed out because your team signed in on another device (only one device per team), or an organizer reset your PIN.")
    return team


def admin_ip_allowed(request: Request) -> bool:
    allowed = [item.strip() for item in env("ADMIN_ALLOWED_IPS").split(",") if item.strip()]
    if not allowed:
        return True
    try:
        address = ipaddress.ip_address(client_ip(request))
    except ValueError:
        return False
    for item in allowed:
        try:
            if address in ipaddress.ip_network(item, strict=False):
                return True
        except ValueError:
            continue
    return False


def require_console(request: Request) -> None:
    """Hide every organizer endpoint unless the caller knows the console path."""
    path = console_path()
    supplied = request.headers.get("x-console-key", "")
    if not path or not hmac.compare_digest(supplied.encode(), path.encode()) or not admin_ip_allowed(request):
        raise ApiError(404, "Not found.")


def require_admin(request: Request) -> None:
    require_console(request)
    claims = read_token(bearer(request, "Bearer"))
    if not claims or claims.get("scope") != "admin":
        raise ApiError(401, "Organizer sign-in required.")


# ── Team state ───────────────────────────────────────────────────────────────

# PIN hashing is deliberately slow (about 150 ms of CPU). Limit how many run at
# once so a sign-in rush cannot starve polling and gameplay requests, and
# remember recent successful checks so teammates joining the same team are cheap.
_pin_slots = threading.BoundedSemaphore(1)
_verified_pins: dict[str, tuple[float, str]] = {}
VERIFIED_PIN_TTL = 15 * 60


def hash_pin(pin: str, salt: bytes, iterations: int = PIN_ITERATIONS) -> str:
    with _pin_slots:
        return hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, iterations).hex()


def _pin_fingerprint(team: dict, pin: str) -> str:
    material = f"{team.get('pinHash', '')}:{pin}".encode()
    return hmac.new(session_secret().encode(), material, hashlib.sha256).hexdigest()


def remember_pin(team: dict, pin: str) -> None:
    with _cache_lock:
        _verified_pins[str(team.get("_id"))] = (time.monotonic(), _pin_fingerprint(team, pin))


def pin_matches(team: dict, pin: str) -> bool:
    expected = str(team.get("pinHash", ""))
    if not expected:
        return False
    fingerprint = _pin_fingerprint(team, pin)
    with _cache_lock:
        hit = _verified_pins.get(str(team.get("_id")))
    if hit and time.monotonic() - hit[0] < VERIFIED_PIN_TTL and hmac.compare_digest(hit[1], fingerprint):
        return True
    try:
        iterations = int(team.get("pinIterations", LEGACY_PIN_ITERATIONS))
        ok = hmac.compare_digest(hash_pin(pin, bytes.fromhex(team.get("pinSalt", "")), iterations), expected)
    except (TypeError, ValueError):
        return False
    if ok:
        remember_pin(team, pin)
    return ok


def new_team(team_id: str) -> dict:
    return {
        "teamId": team_id,
        "industry": "",
        "round": 1,
        "companyValue": rules.BASE_BUDGET,
        "valueEnteredAt": time.time_ns() // 1000,
        "history": [],
        "flashCompleted": {},
        "datasetDownloaded": {},
        "activeFlash": None,
        "roundWaitUntil": 0,
        "isEliminated": False,
        "moneyRevision": 0,
        "sessionVersion": 0,
        "createdAt": utc_now(),
    }


def normalize_history(team: dict) -> list[dict]:
    """Accept history written by the previous client-scored version as well."""
    items = []
    for item in team.get("history") or []:
        if not isinstance(item, dict) or "round" not in item:
            continue
        budget = int(item.get("budget", item.get("roundBudget", rules.BASE_BUDGET)) or rules.BASE_BUDGET)
        payout = int(round(float(item.get("payout", item.get("finalPayout", item.get("newValue", 0))) or 0)))
        items.append({
            "round": int(item["round"]),
            "budget": budget,
            "bonus": int(item.get("bonus", item.get("roundBonus", 0)) or 0),
            "allocations": item.get("allocations") or item.get("investedAmounts") or {},
            "returns": item.get("returns") or item.get("departmentRevenues") or {},
            "payout": payout,
            "netProfit": int(item.get("netProfit", payout - budget)),
            "eliminated": bool(item.get("eliminated")),
            "submittedAt": int(item.get("submittedAt", 0) or 0),
        })
    return sorted(items, key=lambda entry: entry["round"])


def flag_map(team: dict, key: str, legacy_key: str) -> dict[str, bool]:
    result = {str(k): bool(v) for k, v in (team.get(key) or {}).items() if v}
    for legacy, value in (team.get(legacy_key) or {}).items():
        if value:
            result[str(legacy).rsplit("-", 1)[-1]] = True
    return result


def round_budget(team: dict) -> int:
    return max(0, int(round(float(team.get("companyValue", 0) or 0)))) + rules.round_bonus(int(team.get("round", 1)))


def flash_remaining_ms(team: dict, timer: dict, now: int) -> int:
    active = team.get("activeFlash") or {}
    if not active or not timer["enabled"]:
        return 0
    started = max(int(active.get("startedAt", 0) or 0), int(timer["changedAt"]))
    return max(0, started + rules.FLASH_DURATION_MS - now)


def flash_pages(round_number: int) -> int:
    def load():
        folder = FLASH_DIR / f"flash-{round_number}"
        return len(list(folder.glob("page-*.webp"))) if folder.is_dir() else 0
    return cached(f"pages-{round_number}", 3600, load)


def team_view(team: dict, include_capacity: bool = False) -> dict:
    current = settings()
    now = now_ms()
    history = normalize_history(team)
    round_number = int(team.get("round", 1) or 1)
    industry = team.get("industry") or ""
    submitted = any(item["round"] == round_number for item in history)
    finished = bool(team.get("isEliminated")) or (round_number >= rules.ROUNDS and submitted)
    flash_done = flag_map(team, "flashCompleted", "flashCompletedRounds")
    downloaded = flag_map(team, "datasetDownloaded", "datasetDownloadedRounds")
    active = team.get("activeFlash") if isinstance(team.get("activeFlash"), dict) else None
    if active and "round" not in active and str(active.get("id", "")).startswith("flash-"):
        active = {"round": int(str(active["id"]).split("-")[1]), "startedAt": active.get("startedAt", 0)}
    wait_until = int(team.get("roundWaitUntil", 0) or 0)
    view = {
        "teamId": team.get("teamId", ""),
        "industry": industry,
        "round": round_number,
        "rounds": rules.ROUNDS,
        "companyValue": int(round(float(team.get("companyValue", 0) or 0))),
        "moneyRevision": int(team.get("moneyRevision", 0) or 0),
        "budget": round_budget(team) if industry else 0,
        "bonus": rules.round_bonus(round_number),
        "minAllocation": rules.MIN_ALLOCATION,
        "parameters": rules.PARAMETERS.get(industry, []),
        "history": history,
        "flashCompleted": flash_done.get(str(round_number), False),
        "datasetDownloaded": downloaded.get(str(round_number), False),
        "datasetName": rules.dataset_filename(industry, round_number).split("/")[-1] if industry else "",
        "flashPages": flash_pages(round_number),
        "activeFlash": {
            "round": int(active.get("round", round_number)),
            "remainingMs": flash_remaining_ms({"activeFlash": active}, current["flashTimer"], now),
        } if active else None,
        "submitted": submitted,
        "finished": finished,
        "isEliminated": bool(team.get("isEliminated")),
        "roundWaitRemainingMs": max(0, wait_until - now) if current["roundWait"]["enabled"] and submitted and not finished else 0,
        "settings": current,
        "serverNow": now,
    }
    if include_capacity or not industry:
        view["industryCapacity"] = industry_capacity()
    return view


def touch(team: dict) -> None:
    if time.time() - float(team.get("lastSeenEpoch", 0) or 0) >= LAST_SEEN_WRITE_INTERVAL:
        db().data_tycoon_teams.update_one({"_id": team["_id"]}, {"$set": {"lastSeenEpoch": time.time()}})


def reload_team(team: dict) -> dict:
    return db().data_tycoon_teams.find_one({"_id": team["_id"]}) or team


# ── Middleware ───────────────────────────────────────────────────────────────

@app.middleware("http")
async def platform_routing(request: Request, call_next):
    # vercel.json rewrites every /api/* and unknown path to this function and
    # passes the original route in `route`. Restore it so routes match the
    # same way they do when this app runs as a normal server.
    query = parse_qsl(request.scope.get("query_string", b"").decode(), keep_blank_values=True)
    route = next((value for key, value in query if key == "route"), None)
    if route is not None:
        rest = [(key, value) for key, value in query if key not in ("route", "path")]
        path = "/" + route.lstrip("/")
        if path.startswith("/__site/"):
            path = path[len("/__site"):]
        elif not path.startswith("/api/"):
            path = "/api" + path
        request.scope["path"] = path
        request.scope["raw_path"] = path.encode()
        request.scope["query_string"] = urlencode(rest).encode()
    try:
        response = await call_next(request)
    except Exception:  # pragma: no cover - last resort, details stay in logs
        response = json_response({"error": "Unexpected server error."}, 500)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response


@app.exception_handler(ApiError)
async def api_error_handler(_request: Request, error: ApiError):
    return json_response({"error": error.message, **error.extra}, error.status)


@app.exception_handler(PyMongoError)
async def database_error_handler(_request: Request, _error: PyMongoError):
    return json_response({"error": "The event database is busy or unreachable. Please try again in a moment."}, 503)


# ── Public routes ────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    db().command("ping")
    return json_response({"ok": True, "service": "data-tycoon"})


@app.get("/api/leaderboard")
def leaderboard():
    def load():
        rows = db().data_tycoon_teams.find(
            {}, {"_id": 0, "teamId": 1, "industry": 1, "round": 1, "companyValue": 1, "isEliminated": 1}
        ).sort([("companyValue", DESCENDING), ("valueEnteredAt", ASCENDING), ("teamId", ASCENDING)]).limit(500)
        return [
            {"teamId": row.get("teamId", ""), "industry": row.get("industry", ""), "round": int(row.get("round", 1) or 1),
             "companyValue": int(round(float(row.get("companyValue", 0) or 0))), "isEliminated": bool(row.get("isEliminated"))}
            for row in rows
        ]
    return json_response(cached("leaderboard", PUBLIC_CACHE_SECONDS, load), cache_seconds=PUBLIC_CACHE_SECONDS)


@app.get("/api/industry-capacity")
def capacity_route():
    return json_response(industry_capacity(), cache_seconds=PUBLIC_CACHE_SECONDS)


@app.post("/api/team/connect")
async def team_connect(request: Request):
    body = await json_body(request)
    team_id = clean_text(body.get("teamId"), 80)
    pin = str(body.get("pin", ""))
    if len(team_id) < 2:
        raise ApiError(400, "Enter your team name.")
    if not 4 <= len(pin) <= 64:
        raise ApiError(400, "The team PIN must be between 4 and 64 characters.")
    return connect_team(team_id, pin, client_ip(request))


def connect_team(team_id: str, pin: str, ip: str):
    key = team_key(team_id)
    ip_key, team_limit_key = f"team-ip:{ip}", f"team:{key}"
    if rate_limited(ip_key, 30, 60) or rate_limited(team_limit_key, 10, 300):
        raise ApiError(429, "Too many incorrect PIN attempts. Wait a few minutes, then try again.")
    collection = db().data_tycoon_teams
    team = collection.find_one({"_id": key})
    if team is None:
        if not TEAM_NAME_PATTERN.match(team_id):
            raise ApiError(400, "Team names must be 2 to 40 characters: letters, numbers, spaces and basic punctuation.")
        salt = secrets.token_bytes(16)
        team = {**new_team(team_id), "_id": key, "pinSalt": salt.hex(), "pinHash": hash_pin(pin, salt), "pinIterations": PIN_ITERATIONS}
        try:
            collection.insert_one(team)
            remember_pin(team, pin)  # just hashed it; no need to hash again
        except DuplicateKeyError:
            team = collection.find_one({"_id": key})
    if not team.get("pinHash"):
        # Pre-PIN record or organizer PIN reset: the first PIN entered becomes the team PIN.
        salt = secrets.token_bytes(16)
        collection.update_one(
            {"_id": key, "$or": [{"pinHash": {"$exists": False}}, {"pinHash": ""}, {"pinHash": None}]},
            {"$set": {"pinSalt": salt.hex(), "pinHash": hash_pin(pin, salt), "pinIterations": PIN_ITERATIONS}},
        )
        team = collection.find_one({"_id": key})
    if not pin_matches(team, pin):
        note_failure(ip_key, team_limit_key)
        raise ApiError(401, "That PIN does not match this team. Check with your teammates and try again.")
    # One device per team: signing in revokes the token held by any other device.
    team = collection.find_one_and_update(
        {"_id": key}, {"$set": {"lastSeenEpoch": time.time()}, "$inc": {"sessionVersion": 1}}, return_document=ReturnDocument.AFTER
    )
    record_activity(team, "team-connected", "Signed in (any other device for this team was signed out).")
    token = sign_token({"scope": "team", "teamKey": key, "sv": int(team.get("sessionVersion", 0)), "exp": int(time.time()) + TEAM_TOKEN_TTL})
    return json_response({"token": token, "state": team_view(team)})


# ── Team routes ──────────────────────────────────────────────────────────────

@app.get("/api/team/state")
def team_state(request: Request):
    team = require_team(request)
    touch(team)
    return json_response(team_view(team))


@app.post("/api/team/industry")
async def choose_industry(request: Request):
    body = await json_body(request)
    team = require_team(request)
    industry = clean_text(body.get("industry"), 40)
    if industry not in rules.INDUSTRIES:
        raise ApiError(400, "Choose one of the listed industries.")
    if team.get("industry"):
        if team["industry"] == industry:
            return json_response(team_view(team))
        raise ApiError(409, "Your team's industry is already locked.", state=team_view(team))
    database = db()
    industry_capacity()  # make sure counters exist
    slot = database.data_tycoon_industry_capacity.find_one_and_update(
        {"_id": industry, "count": {"$lt": rules.INDUSTRY_CAPACITY}}, {"$inc": {"count": 1}}, return_document=ReturnDocument.AFTER
    )
    if not slot:
        invalidate("capacity")
        raise ApiError(409, f"{industry} is full ({rules.INDUSTRY_CAPACITY} teams). Choose an industry with seats left.", state=team_view(team, True))
    updated = database.data_tycoon_teams.find_one_and_update(
        {"_id": team["_id"], "$or": [{"industry": ""}, {"industry": None}, {"industry": {"$exists": False}}]},
        {"$set": {"industry": industry}},
        return_document=ReturnDocument.AFTER,
    )
    invalidate("capacity")
    if not updated:
        database.data_tycoon_industry_capacity.update_one({"_id": industry, "count": {"$gt": 0}}, {"$inc": {"count": -1}})
        team = reload_team(team)
        if team.get("industry") == industry:
            return json_response(team_view(team))
        raise ApiError(409, "Your team's industry is already locked.", state=team_view(team))
    record_activity(updated, "industry-locked", f"Locked industry: {industry}.")
    return json_response(team_view(updated))


def require_playable(team: dict) -> int:
    if not team.get("industry"):
        raise ApiError(409, "Choose your industry first.")
    view_history = normalize_history(team)
    round_number = int(team.get("round", 1) or 1)
    if team.get("isEliminated") or (round_number >= rules.ROUNDS and any(item["round"] == round_number for item in view_history)):
        raise ApiError(409, "Your team has finished the game.")
    return round_number


@app.post("/api/team/flash/open")
def open_flash(request: Request):
    team = require_team(request)
    round_number = require_playable(team)
    active = team.get("activeFlash") or {}
    if active.get("round") != round_number:
        started = now_ms()
        db().data_tycoon_teams.update_one({"_id": team["_id"]}, {"$set": {"activeFlash": {"round": round_number, "startedAt": started}}})
        if not flag_map(team, "flashCompleted", "flashCompletedRounds").get(str(round_number)):
            record_activity(team, "flash-opened", f"Opened Flash {round_number}.")
        team = reload_team(team)
    return json_response(team_view(team))


@app.post("/api/team/flash/close")
def close_flash(request: Request):
    team = require_team(request)
    round_number = int(team.get("round", 1) or 1)
    active = team.get("activeFlash") or {}
    already_done = flag_map(team, "flashCompleted", "flashCompletedRounds").get(str(round_number), False)
    if active:
        timer = settings()["flashTimer"]
        remaining = flash_remaining_ms(team, timer, now_ms())
        if not already_done and remaining > FLASH_GRACE_MS:
            raise ApiError(409, "The flash timer is still running.", remainingMs=remaining)
        update = {"$set": {"activeFlash": None, f"flashCompleted.{round_number}": True}}
        db().data_tycoon_teams.update_one({"_id": team["_id"]}, update)
        if not already_done:
            record_activity(team, "flash-completed", f"Finished reading Flash {round_number}.")
        team = reload_team(team)
    return json_response(team_view(team))


@app.get("/api/team/flash/page/{page_number}")
def flash_page(request: Request, page_number: int, round_param: int = Query(0, alias="round")):
    team = require_team(request)
    current = int(team.get("round", 1) or 1)
    round_number = round_param or current
    done = flag_map(team, "flashCompleted", "flashCompletedRounds")
    active = team.get("activeFlash") or {}
    allowed = round_number < current or (round_number == current and (active.get("round") == current or done.get(str(current))))
    if not allowed or not 1 <= round_number <= rules.ROUNDS:
        raise ApiError(403, "Open this round's flash from your dashboard first.")
    path = FLASH_DIR / f"flash-{round_number}" / f"page-{page_number}.webp"
    if not path.is_file():
        raise ApiError(404, "Page not found.")
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/team/dataset")
def download_dataset(request: Request):
    team = require_team(request)
    round_number = require_playable(team)
    if not flag_map(team, "flashCompleted", "flashCompletedRounds").get(str(round_number)):
        raise ApiError(403, "Finish reading this round's flash to unlock the dataset.")
    relative = rules.dataset_filename(team["industry"], round_number)
    path = DATASET_DIR / relative
    if not path.is_file():
        raise ApiError(404, "The dataset for this round is missing on the server. Tell an organizer.")
    if not flag_map(team, "datasetDownloaded", "datasetDownloadedRounds").get(str(round_number)):
        db().data_tycoon_teams.update_one({"_id": team["_id"]}, {"$set": {f"datasetDownloaded.{round_number}": True}})
        record_activity(team, "dataset-downloaded", f"Downloaded the Flash {round_number} dataset.")
    filename = f"{rules.DATASET_SLUGS[team['industry']]}-round-{round_number}.{path.suffix.lstrip('.')}"
    media = "text/csv" if path.suffix == ".csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return FileResponse(path, media_type=media, filename=filename, headers={"Cache-Control": "private, no-store"})


@app.post("/api/team/submit")
async def submit_round(request: Request):
    body = await json_body(request)
    team = require_team(request)
    round_number = require_playable(team)
    if int(body.get("round", 0) or 0) != round_number:
        raise ApiError(409, "Your round changed. Review the dashboard and submit again.", state=team_view(team))
    if any(item["round"] == round_number for item in normalize_history(team)):
        raise ApiError(409, "This round is already submitted.", state=team_view(team))
    if not flag_map(team, "flashCompleted", "flashCompletedRounds").get(str(round_number)):
        raise ApiError(409, "Finish reading this round's flash first.")
    if not flag_map(team, "datasetDownloaded", "datasetDownloadedRounds").get(str(round_number)):
        raise ApiError(409, "Download this round's dataset first.")
    budget = round_budget(team)
    allocations, error = rules.validate_allocations(team["industry"], budget, body.get("allocations"))
    if error:
        raise ApiError(400, error, budget=budget)
    outcome = rules.score_round(team["industry"], round_number, budget, allocations)
    submitted_at = now_ms()
    entry = {
        "round": round_number, "budget": budget, "bonus": rules.round_bonus(round_number), "allocations": allocations,
        "returns": outcome["returns"], "payout": outcome["payout"], "netProfit": outcome["netProfit"],
        "eliminated": outcome["eliminated"], "submittedAt": submitted_at,
    }
    updated = db().data_tycoon_teams.find_one_and_update(
        {"_id": team["_id"], "round": team.get("round", 1), "companyValue": team.get("companyValue"), "history.round": {"$ne": round_number}},
        {
            "$push": {"history": entry},
            "$set": {
                "companyValue": max(0, outcome["payout"]),
                "valueEnteredAt": time.time_ns() // 1000,
                "isEliminated": outcome["eliminated"],
                "roundWaitUntil": submitted_at + rules.ROUND_WAIT_MS if round_number < rules.ROUNDS and not outcome["eliminated"] else 0,
                "activeFlash": None,
            },
        },
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise ApiError(409, "Your balance or round changed while you were submitting. Review the new budget and submit again.", state=team_view(reload_team(team)))
    invalidate("leaderboard")
    record_activity(updated, "round-submitted", f"Submitted Flash {round_number}: payout ₹{outcome['payout']:,}" + (" (eliminated)." if outcome["eliminated"] else "."))
    return json_response(team_view(updated))


@app.post("/api/team/advance")
async def advance_round(request: Request):
    body = await json_body(request)
    team = require_team(request)
    round_number = require_playable(team)
    if int(body.get("round", 0) or 0) != round_number:
        return json_response(team_view(team))  # already advanced in another tab
    if not any(item["round"] == round_number for item in normalize_history(team)):
        raise ApiError(409, "Submit this round before moving on.")
    query = {"_id": team["_id"], "round": round_number}
    if settings()["roundWait"]["enabled"]:
        remaining = int(team.get("roundWaitUntil", 0) or 0) - now_ms()
        if remaining > 0:
            raise ApiError(409, "The next round is not open yet.", state=team_view(team))
        query["$or"] = [{"roundWaitUntil": {"$lte": now_ms()}}, {"roundWaitUntil": {"$exists": False}}]
    updated = db().data_tycoon_teams.find_one_and_update(
        query, {"$set": {"round": round_number + 1, "roundWaitUntil": 0, "activeFlash": None}}, return_document=ReturnDocument.AFTER
    )
    team = updated or reload_team(team)
    if updated:
        invalidate("leaderboard")
        record_activity(updated, "round-opened", f"Moved on to Flash {round_number + 1}.")
    return json_response(team_view(team))


@app.post("/api/team/activity")
async def team_activity(request: Request):
    body = await json_body(request)
    team = require_team(request)
    kind = clean_text(body.get("kind"), 48)
    if kind not in PLAYER_ACTIVITY_KINDS:
        raise ApiError(400, "Unknown activity type.")
    since = utc_now() - timedelta(minutes=1)
    recent = db().data_tycoon_activities.count_documents(
        {"teamKey": team["_id"], "createdAt": {"$gte": since}}, limit=ACTIVITY_LIMIT_PER_MINUTE
    )
    if recent >= ACTIVITY_LIMIT_PER_MINUTE:
        return json_response({"ok": True, "throttled": True}, 202)
    record_activity(team, kind, clean_text(body.get("detail"), 240))
    touch(team)
    return json_response({"ok": True}, 202)


# ── Organizer routes ─────────────────────────────────────────────────────────

@app.post("/api/admin/login")
async def admin_login(request: Request):
    require_console(request)
    body = await json_body(request)
    password = env("ADMIN_PASSWORD")
    if not password or not session_secret():
        raise ApiError(503, "Organizer access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET.")
    key = f"admin-ip:{client_ip(request)}"
    if rate_limited(key, 8, 60) or rate_limited("admin-global", 40, 300):
        raise ApiError(429, "Too many sign-in attempts. Wait a minute and try again.")
    if not hmac.compare_digest(str(body.get("password", "")).encode(), password.encode()):
        note_failure(key, "admin-global")
        raise ApiError(401, "Incorrect organizer password.")
    return json_response({"token": sign_token({"scope": "admin", "exp": int(time.time()) + ADMIN_TOKEN_TTL}), "expiresIn": ADMIN_TOKEN_TTL})


@app.get("/api/admin/dashboard")
def admin_dashboard(request: Request, team: str = "", industry: str = "", kind: str = "alerts"):
    require_admin(request)
    database = db()
    now = time.time()
    teams = []
    for row in database.data_tycoon_teams.find(
        {}, {"teamId": 1, "industry": 1, "round": 1, "companyValue": 1, "isEliminated": 1, "lastSeenEpoch": 1, "history.round": 1, "pinHash": 1}
    ).sort([("companyValue", DESCENDING), ("valueEnteredAt", ASCENDING), ("teamId", ASCENDING)]):
        rounds_done = {item.get("round") for item in row.get("history", []) if isinstance(item, dict)}
        teams.append({
            "key": row["_id"], "teamId": row.get("teamId", ""), "industry": row.get("industry", ""),
            "round": int(row.get("round", 1) or 1), "companyValue": int(round(float(row.get("companyValue", 0) or 0))),
            "isEliminated": bool(row.get("isEliminated")), "submitted": int(row.get("round", 1) or 1) in rounds_done,
            "online": now - float(row.get("lastSeenEpoch", 0) or 0) < ONLINE_WINDOW_SECONDS, "hasPin": bool(row.get("pinHash")),
        })
    query: dict = {}
    if kind == "alerts":
        query["kind"] = {"$in": sorted(ALERT_KINDS)}
    elif kind == "screenshots":
        query["kind"] = {"$in": ["screenshot-shortcut", "screenshot-suspected", "print-attempt", "devtools-shortcut"]}
    elif kind == "focus":
        query["kind"] = {"$in": ["tab-hidden", "window-blur", "focus-return"]}
    if team:
        query["teamKey"] = team_key(team)
    if industry:
        query["industry"] = clean_text(industry, 40)
    activities = [
        {"teamId": row.get("teamId", ""), "industry": row.get("industry", ""), "round": row.get("round", 1), "kind": row.get("kind", ""),
         "detail": row.get("detail", ""), "actor": row.get("actor", "team"), "timestamp": row["_id"].generation_time.isoformat()}
        for row in database.data_tycoon_activities.find(query).sort("_id", DESCENDING).limit(150)
    ]
    since = utc_now() - timedelta(minutes=10)
    recent_alerts = database.data_tycoon_activities.count_documents({"kind": {"$in": sorted(ALERT_KINDS)}, "createdAt": {"$gte": since}})
    return json_response({
        "teams": teams, "activities": activities, "recentAlerts": recent_alerts,
        "settings": settings(), "industryCapacity": industry_capacity(), "serverNow": now_ms(),
    })


@app.patch("/api/admin/settings")
async def admin_settings(request: Request):
    require_admin(request)
    body = await json_body(request)
    names = {"flashTimer": ("flash-timer", False), "roundWait": ("round-wait", True)}
    database = db()
    for field, (doc_id, default) in names.items():
        if field not in body:
            continue
        enabled = body[field]
        if not isinstance(enabled, bool):
            raise ApiError(400, f"{field} must be true or false.")
        existing = database.data_tycoon_settings.find_one({"_id": doc_id}) or {}
        if bool(existing.get("enabled", default)) != enabled:
            database.data_tycoon_settings.update_one({"_id": doc_id}, {"$set": {"enabled": enabled, "changedAt": now_ms()}}, upsert=True)
    invalidate("settings")
    return json_response(settings())


@app.patch("/api/admin/team-balance")
async def admin_team_balance(request: Request):
    require_admin(request)
    body = await json_body(request)
    amount = body.get("companyValue")
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or not 0 <= amount <= 10**12:
        raise ApiError(400, "Enter a balance between ₹0 and ₹1,000,000,000,000.")
    key = team_key(str(body.get("teamKey", "")))
    team = db().data_tycoon_teams.find_one({"_id": key})
    if not team:
        raise ApiError(404, "Team not found.")
    new_amount = int(round(amount))
    old_amount = int(round(float(team.get("companyValue", 0) or 0)))
    updates = {"companyValue": new_amount}
    if new_amount != old_amount:
        updates["valueEnteredAt"] = time.time_ns() // 1000
    db().data_tycoon_teams.update_one({"_id": key}, {"$set": updates, "$inc": {"moneyRevision": 1}})
    invalidate("leaderboard")
    record_activity(team, "organizer-balance-edit", f"Organizer changed the balance from ₹{old_amount:,} to ₹{new_amount:,}.", "organizer")
    return json_response({"ok": True, "companyValue": new_amount})


@app.post("/api/admin/team-reset-pin")
async def admin_reset_pin(request: Request):
    require_admin(request)
    body = await json_body(request)
    key = team_key(str(body.get("teamKey", "")))
    team = db().data_tycoon_teams.find_one_and_update(
        {"_id": key}, {"$set": {"pinHash": "", "pinSalt": ""}, "$inc": {"sessionVersion": 1}}, return_document=ReturnDocument.AFTER
    )
    if not team:
        raise ApiError(404, "Team not found.")
    record_activity(team, "organizer-pin-reset", "Organizer reset the team PIN and signed out every device.", "organizer")
    return json_response({"ok": True})


# ── Organizer console page (secret path) and site fallback ──────────────────

CONSOLE_FILES = {"admin.js": "text/javascript; charset=utf-8", "admin.css": "text/css; charset=utf-8"}
PRIVATE_HEADERS = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"}


def not_found_page() -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>Not found</title><body style=\"font-family:system-ui;padding:40px\">"
        "<h1>Page not found</h1><p><a href=\"/\">Go to Data Tycoon</a></p>",
        status_code=404,
        headers={"Cache-Control": "no-store"},
    )


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
def unknown_api(rest: str):
    raise ApiError(404, "API route not found.")


@app.get("/{full_path:path}")
def site(request: Request, full_path: str):
    secret = console_path()
    parts = full_path.strip("/").split("/")
    if secret and parts[0] == secret and admin_ip_allowed(request):
        if len(parts) == 1:
            if not full_path.endswith("/"):
                return RedirectResponse(f"/{secret}/", status_code=308, headers=PRIVATE_HEADERS)
            html = (CONSOLE_DIR / "admin.html").read_text(encoding="utf-8").replace("{{CONSOLE_BASE}}", f"/{secret}")
            return HTMLResponse(html, headers=PRIVATE_HEADERS)
        if len(parts) == 2 and parts[1] in CONSOLE_FILES:
            return FileResponse(CONSOLE_DIR / parts[1], media_type=CONSOLE_FILES[parts[1]], headers=PRIVATE_HEADERS)
    if os.environ.get("DATA_TYCOON_SERVE_STATIC") == "1":
        target = (PUBLIC_DIR / full_path).resolve()
        if full_path in {"", "index.html"}:
            target = PUBLIC_DIR / "index.html"
        if target.is_file() and PUBLIC_DIR.resolve() in target.parents:
            headers = {"Cache-Control": "no-cache"}
            return FileResponse(target, headers=headers)
    return not_found_page()
