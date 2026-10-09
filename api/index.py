from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import unquote

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pymongo import DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
TEAM_LOGIN_ATTEMPTS: dict[str, list[float]] = {}
MAX_ACTIVITIES = 1500
ACTIVITY_PRUNE_EVERY = 100
ACTIVITY_WRITES_SINCE_PRUNE = 0
MONGO_CLIENT: MongoClient | None = None
MONGO_INDEXES_READY = False


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_text(value, limit: int = 160) -> str:
    return " ".join(str(value or "").strip().split())[:limit]


def team_key(team_id: str) -> str:
    return clean_text(team_id, 80).casefold()


def mongo_database():
    global MONGO_CLIENT, MONGO_INDEXES_READY
    value = os.environ.get("MONGODB_URI", "").strip()
    if not value:
        raise RuntimeError("Set MONGODB_URI in the Vercel project environment variables.")
    if MONGO_CLIENT is None:
        MONGO_CLIENT = MongoClient(value, serverSelectionTimeoutMS=8000, maxPoolSize=10)
    database_name = os.environ.get("MONGODB_DATABASE", "data_tycoon").strip() or "data_tycoon"
    db = MONGO_CLIENT[database_name]
    if not MONGO_INDEXES_READY:
        db.data_tycoon_activities.create_index([("teamKey", 1), ("_id", DESCENDING)])
        db.data_tycoon_teams.create_index([("companyValue", DESCENDING), ("teamId", 1)], name="leaderboard_value_team")
        MONGO_INDEXES_READY = True
    return db


def load_team(db, key: str) -> dict | None:
    team = db.data_tycoon_teams.find_one({"_id": key})
    if team:
        team.pop("_id", None)
    return team


def save_team(db, team: dict) -> None:
    document = {**team, "_id": team_key(team["teamId"])}
    db.data_tycoon_teams.replace_one({"_id": document["_id"]}, document, upsert=True)


def append_activity(db, team_id: str, kind: str, detail: str, actor: str = "team") -> None:
    global ACTIVITY_WRITES_SINCE_PRUNE
    activity = {
        "id": secrets.token_hex(8),
        "teamId": clean_text(team_id, 80),
        "kind": clean_text(kind, 48),
        "detail": clean_text(detail, 220),
        "actor": actor,
        "timestamp": utc_now(),
    }
    db.data_tycoon_activities.insert_one({**activity, "teamKey": team_key(activity["teamId"])})
    ACTIVITY_WRITES_SINCE_PRUNE += 1
    if ACTIVITY_WRITES_SINCE_PRUNE < ACTIVITY_PRUNE_EVERY:
        return
    ACTIVITY_WRITES_SINCE_PRUNE = 0
    old_records = db.data_tycoon_activities.find({}, {"_id": 1}).sort("_id", DESCENDING).skip(MAX_ACTIVITIES)
    old_ids = [record["_id"] for record in old_records]
    if old_ids:
        db.data_tycoon_activities.delete_many({"_id": {"$in": old_ids}})


def safe_allocations(value) -> dict:
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, amount in list(value.items())[:20]:
        try:
            number = float(amount)
            if math.isfinite(number) and 0 <= number <= 10**12:
                result[clean_text(key, 100)] = number
        except (TypeError, ValueError):
            continue
    return result


def safe_boolean_map(value, limit: int = 20) -> dict:
    if not isinstance(value, dict):
        return {}
    return {clean_text(key, 120): bool(flag) for key, flag in list(value.items())[:limit]}


def safe_active_flash(value) -> dict | None:
    if not isinstance(value, dict) or value.get("id") not in {f"flash-{round_number}" for round_number in range(1, 5)}:
        return None
    try:
        started_at = int(value.get("startedAt"))
        duration = int(value.get("duration", 300_000))
    except (TypeError, ValueError):
        return None
    if started_at <= 0 or duration < 1 or duration > 300_000:
        return None
    return {"id": value["id"], "startedAt": started_at, "duration": duration}


def public_team(team: dict) -> dict:
    return {key: value for key, value in team.items() if key not in {"adminOverride", "pinSalt", "pinHash"}}


def player_team(team: dict) -> dict:
    return public_team(team)


def team_pin_matches(team: dict, pin: str) -> bool:
    try:
        salt = bytes.fromhex(team.get("pinSalt", ""))
        expected_hash = str(team.get("pinHash", ""))
        candidate = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 260_000).hex()
        return bool(expected_hash) and hmac.compare_digest(candidate, expected_hash)
    except (TypeError, ValueError):
        return False


def flash_timer_settings(db) -> dict:
    row = db.data_tycoon_settings.find_one({"_id": "flash-timer"}) or {}
    return {"enabled": bool(row.get("enabled", False)), "changedAt": int(row.get("changedAt", 0))}


def session_secret() -> str:
    return os.environ.get("ADMIN_SESSION_SECRET") or os.environ.get("ADMIN_PASSWORD", "")


def issue_token() -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"exp": int(time.time()) + 8 * 60 * 60, "nonce": secrets.token_hex(8)}).encode()
    ).decode().rstrip("=")
    signature = hmac.new(session_secret().encode(), payload.encode(), hashlib.sha256).digest()
    return payload + "." + base64.urlsafe_b64encode(signature).decode().rstrip("=")


def token_is_valid(token: str) -> bool:
    secret = session_secret()
    if not secret or "." not in token:
        return False
    payload, supplied_signature = token.split(".", 1)
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    try:
        supplied = base64.urlsafe_b64decode(supplied_signature + "=" * (-len(supplied_signature) % 4))
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, json.JSONDecodeError):
        return False
    return hmac.compare_digest(expected, supplied) and claims.get("exp", 0) > time.time() and claims.get("scope") != "team"


def issue_team_token(key: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({
        "exp": int(time.time()) + 30 * 24 * 60 * 60,
        "scope": "team",
        "teamKey": key,
        "nonce": secrets.token_hex(8),
    }).encode()).decode().rstrip("=")
    signature = hmac.new(session_secret().encode(), payload.encode(), hashlib.sha256).digest()
    return payload + "." + base64.urlsafe_b64encode(signature).decode().rstrip("=")


def team_token_is_valid(token: str, key: str) -> bool:
    if not token or "." not in token or not session_secret():
        return False
    payload, supplied_signature = token.split(".", 1)
    expected = hmac.new(session_secret().encode(), payload.encode(), hashlib.sha256).digest()
    try:
        supplied = base64.urlsafe_b64decode(supplied_signature + "=" * (-len(supplied_signature) % 4))
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, json.JSONDecodeError):
        return False
    return (
        hmac.compare_digest(expected, supplied)
        and claims.get("scope") == "team"
        and claims.get("teamKey") == key
        and claims.get("exp", 0) > time.time()
    )


def team_authorized(request: Request, team_id: str) -> bool:
    header = request.headers.get("authorization", "")
    token = header[5:] if header.startswith("Team ") else ""
    return team_token_is_valid(token, team_key(team_id))


def admin_authorized(request: Request) -> bool:
    header = request.headers.get("authorization", "")
    token = header[7:] if header.startswith("Bearer ") else ""
    return token_is_valid(token)


async def request_json(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > 1_000_000:
        raise ValueError("Request body is too large.")
    value = json.loads(raw or b"{}")
    if not isinstance(value, dict):
        raise ValueError("Request body must be a JSON object.")
    return value


def api_path(request: Request) -> str:
    # vercel.json rewrites /api/<path> to this single function and passes the
    # original route in `route`; the path fallback also supports direct calls.
    route = request.query_params.get("route")
    if route is None:
        route = request.url.path.removeprefix("/api").strip("/")
    return unquote(route).strip("/")


def json_response(payload, status_code: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store"})


async def handle_api(request: Request) -> Response:
    method = request.method.upper()
    route = api_path(request)

    if method == "OPTIONS":
        return Response(status_code=204, headers={
            "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "600",
            "Cache-Control": "no-store",
        })

    if method == "POST" and route == "team/connect":
        try:
            body = await request_json(request)
        except (ValueError, json.JSONDecodeError) as error:
            return json_response({"error": str(error)}, 400)
        team_id = clean_text(body.get("teamId"), 80)
        pin = str(body.get("pin", ""))
        if not team_id or len(pin) < 4 or len(pin) > 64:
            return json_response({"error": "Enter a team name and a PIN between 4 and 64 characters."}, 400)
        if not session_secret():
            return json_response({"error": "Organizer session secret is not configured."}, 503)
        forwarded_for = request.headers.get("x-forwarded-for", "")
        client_ip = forwarded_for.split(",", 1)[0].strip() or (request.client.host if request.client else "unknown")
        now = time.time()
        attempts = [timestamp for timestamp in TEAM_LOGIN_ATTEMPTS.get(client_ip, []) if now - timestamp < 60]
        if len(attempts) >= 8:
            TEAM_LOGIN_ATTEMPTS[client_ip] = attempts
            return json_response({"error": "Too many team sign-in attempts. Wait a minute and try again."}, 429)
        key = team_key(team_id)
        try:
            db = mongo_database()
            team = load_team(db, key)
            if team and team.get("pinHash"):
                if not team_pin_matches(team, pin):
                    attempts.append(now)
                    TEAM_LOGIN_ATTEMPTS[client_ip] = attempts
                    return json_response({"error": "Incorrect team PIN."}, 401)
            elif team:
                # Migrate a pre-PIN team exactly once. If another teammate signs in
                # concurrently, the first PIN saved becomes the team's shared PIN.
                salt = secrets.token_bytes(16)
                pin_hash = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 260_000).hex()
                db.data_tycoon_teams.update_one(
                    {"_id": key, "$or": [{"pinHash": {"$exists": False}}, {"pinHash": ""}]},
                    {"$set": {"pinSalt": salt.hex(), "pinHash": pin_hash}},
                )
                team = load_team(db, key)
                if not team or not team_pin_matches(team, pin):
                    attempts.append(now)
                    TEAM_LOGIN_ATTEMPTS[client_ip] = attempts
                    return json_response({"error": "Incorrect team PIN."}, 401)
            else:
                team = team or {
                    "teamId": team_id,
                    "industry": "",
                    "round": 1,
                    "companyValue": 1_000_000,
                    "allocations": {},
                    "history": [],
                    "page": "industries",
                    "isEliminated": False,
                    "moneyRevision": 0,
                    "flashCompletedRounds": {},
                    "datasetDownloadedRounds": {},
                    "offlineBonusClaimed": {"round3": False, "round4": False},
                    "round2GrantApplied": False,
                }
                salt = secrets.token_bytes(16)
                team["pinSalt"] = salt.hex()
                team["pinHash"] = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 260_000).hex()
                try:
                    db.data_tycoon_teams.insert_one({**team, "_id": key})
                except DuplicateKeyError:
                    # Another first sign-in claimed this normalized team name while
                    # this request was hashing the PIN. Authenticate against the
                    # stored account instead of replacing its PIN.
                    team = load_team(db, key)
                    if not team or not team_pin_matches(team, pin):
                        attempts.append(now)
                        TEAM_LOGIN_ATTEMPTS[client_ip] = attempts
                        return json_response({"error": "Incorrect team PIN."}, 401)

            team["updatedAt"] = utc_now()
            team["lastSeenEpoch"] = now
            save_team(db, team)
            TEAM_LOGIN_ATTEMPTS.pop(client_ip, None)
            return json_response({"token": issue_team_token(key), "team": player_team(team)})
        except Exception:
            return json_response({"error": "Could not connect to the team database. Check MONGODB_URI."}, 503)

    if method == "GET" and route == "health":
        try:
            mongo_database().command("ping")
            return json_response({"ok": True, "service": "data-tycoon"})
        except Exception:
            return json_response({"ok": False, "error": "Database unavailable. Check MONGODB_URI."}, 503)

    if method == "GET" and route == "settings/flash-timer":
        try:
            return json_response(flash_timer_settings(mongo_database()))
        except Exception:
            return json_response({"error": "Could not load flash timer settings."}, 503)

    if method == "POST" and route == "admin/login":
        try:
            body = await request_json(request)
        except (ValueError, json.JSONDecodeError) as error:
            return json_response({"error": str(error)}, 400)
        now = time.time()
        forwarded_for = request.headers.get("x-forwarded-for", "")
        client_ip = forwarded_for.split(",", 1)[0].strip() or (request.client.host if request.client else "unknown")
        attempts = [timestamp for timestamp in LOGIN_ATTEMPTS.get(client_ip, []) if now - timestamp < 60]
        if len(attempts) >= 8:
            LOGIN_ATTEMPTS[client_ip] = attempts
            return json_response({"error": "Too many sign-in attempts. Wait a minute and try again."}, 429)
        password = os.environ.get("ADMIN_PASSWORD", "")
        if not password:
            return json_response({"error": "Set ADMIN_PASSWORD in Vercel project environment variables."}, 503)
        supplied = str(body.get("password", ""))
        if not hmac.compare_digest(supplied.encode(), password.encode()):
            attempts.append(now)
            LOGIN_ATTEMPTS[client_ip] = attempts
            return json_response({"error": "Incorrect organizer password."}, 401)
        LOGIN_ATTEMPTS.pop(client_ip, None)
        return json_response({"token": issue_token(), "expiresIn": 8 * 60 * 60})

    if method == "GET" and route.startswith("team/") and route.endswith("/balance"):
        requested_id = unquote(route[len("team/"):-len("/balance")])
        if not team_authorized(request, requested_id):
            return json_response({"error": "Team sign-in required. Enter the team PIN again."}, 401)
        try:
            row = mongo_database().data_tycoon_teams.find_one(
                {"_id": team_key(requested_id)},
                {"_id": 0, "companyValue": 1, "moneyRevision": 1},
            )
            if not row:
                return json_response({"error": "Team not found."}, 404)
            return json_response(row)
        except Exception:
            return json_response({"error": "Database unavailable. Check MONGODB_URI."}, 503)

    if method == "GET" and route.startswith("team/"):
        requested_id = unquote(route[len("team/"):])
        if not team_authorized(request, requested_id):
            return json_response({"error": "Team sign-in required. Enter the team PIN again."}, 401)
        try:
            db = mongo_database()
            team = load_team(db, team_key(requested_id))
            if not team:
                return json_response({"error": "Team not found."}, 404)
            return json_response(player_team(team))
        except Exception:
            return json_response({"error": "Database unavailable. Check MONGODB_URI."}, 503)

    if method == "GET" and route == "leaderboard":
        try:
            db = mongo_database()
            teams = list(db.data_tycoon_teams.find(
                {}, {"_id": 0, "teamId": 1, "industry": 1, "round": 1, "companyValue": 1, "isEliminated": 1}
            ).sort([("companyValue", DESCENDING), ("teamId", 1)]))
            return json_response(teams)
        except Exception:
            return json_response({"error": "Could not load the leaderboard. Check MONGODB_URI."}, 503)

    if method == "GET" and route == "admin/dashboard":
        if not admin_authorized(request):
            return json_response({"error": "Organizer sign-in required."}, 401)
        filter_team = request.query_params.get("teamId", "").casefold()
        try:
            db = mongo_database()
            now = time.time()
            team_projection = {
                "_id": 0, "teamId": 1, "industry": 1, "round": 1,
                "companyValue": 1, "isEliminated": 1, "lastSeenEpoch": 1,
            }
            rows = db.data_tycoon_teams.find({}, team_projection).sort(
                [("companyValue", DESCENDING), ("teamId", 1)]
            )
            teams = [
                dict(row, online=now - float(row.get("lastSeenEpoch", 0)) < 45)
                for row in rows
            ]
            query = {"teamKey": filter_team} if filter_team else {}
            activities = list(
                db.data_tycoon_activities.find(query, {"_id": 0, "teamKey": 0})
                .sort("_id", DESCENDING)
                .limit(100)
            )
            return json_response({"teams": teams, "activities": activities, "flashTimer": flash_timer_settings(db)})
        except Exception:
            return json_response({"error": "Database unavailable. Check MONGODB_URI."}, 503)

    if method == "GET" and route == "admin/teams":
        if not admin_authorized(request):
            return json_response({"error": "Organizer sign-in required."}, 401)
        try:
            db = mongo_database()
            projection = {
                "_id": 0, "teamId": 1, "industry": 1, "round": 1,
                "companyValue": 1, "isEliminated": 1, "lastSeenEpoch": 1,
            }
            now = time.time()
            teams = [
                dict(row, online=now - float(row.get("lastSeenEpoch", 0)) < 45)
                for row in db.data_tycoon_teams.find({}, projection).sort(
                    [("companyValue", DESCENDING), ("teamId", 1)]
                )
            ]
            return json_response(teams)
        except Exception:
            return json_response({"error": "Database unavailable. Check MONGODB_URI."}, 503)

    if method == "GET" and route == "admin/activities":
        if not admin_authorized(request):
            return json_response({"error": "Organizer sign-in required."}, 401)
        filter_team = request.query_params.get("teamId", "").casefold()
        try:
            db = mongo_database()
            query = {"teamKey": filter_team} if filter_team else {}
            rows = list(db.data_tycoon_activities.find(query, {"_id": 0, "teamKey": 0}).sort("_id", DESCENDING).limit(250))
            return json_response(rows)
        except Exception:
            return json_response({"error": "Database unavailable. Check MONGODB_URI."}, 503)

    if method == "POST":
        try:
            body = await request_json(request)
        except (ValueError, json.JSONDecodeError) as error:
            return json_response({"error": str(error)}, 400)

        if route == "team/sync":
            team_id = clean_text(body.get("teamId"), 80)
            if not team_id:
                return json_response({"error": "A team name is required."}, 400)
            if not team_authorized(request, team_id):
                return json_response({"error": "Team sign-in required. Enter the team PIN again."}, 401)
            try:
                round_number = max(1, min(4, int(body.get("round", 1))))
                balance = float(body.get("companyValue", 0))
                if not math.isfinite(balance):
                    raise ValueError
                balance = max(0, min(10**12, balance))
            except (TypeError, ValueError):
                return json_response({"error": "Invalid team balance or round."}, 400)
            try:
                db = mongo_database()
                previous = load_team(db, team_key(team_id)) or {}
                incoming_history = body.get("history") if isinstance(body.get("history"), list) else []
                previous_rounds = {item.get("round") for item in previous.get("history", []) if isinstance(item, dict)}
                has_new_result = any(
                    item.get("round") not in previous_rounds for item in incoming_history if isinstance(item, dict)
                )
                preserve_override = previous.get("adminOverride") and not has_new_result
                team = {
                    **previous,
                    "teamId": team_id,
                    "industry": clean_text(previous.get("industry"), 80) or clean_text(body.get("industry"), 80),
                    "round": round_number,
                    "companyValue": previous.get("companyValue", balance) if preserve_override else balance,
                    "allocations": safe_allocations(body.get("allocations")),
                    "history": [
                        item
                        for item in incoming_history if isinstance(item, dict)
                    ][-4:],
                    "page": clean_text(body.get("page"), 24),
                    "isEliminated": bool(body.get("isEliminated")),
                    "moneyRevision": int(previous.get("moneyRevision", 0)),
                    "adminOverride": bool(preserve_override),
                    "updatedAt": utc_now(),
                    "lastSeenEpoch": time.time(),
                    "pendingIndustry": clean_text(body.get("pendingIndustry"), 80),
                    "scoringVersion": 2,
                    "allocationRound": max(1, min(4, int(body.get("allocationRound", round_number)))),
                    "allocationBudget": max(0, min(10**12, float(body.get("allocationBudget", 0)))),
                    "allocationSetupVersion": int(body.get("allocationSetupVersion", 0)),
                    "flashCompletedRounds": safe_boolean_map(body.get("flashCompletedRounds")),
                    "datasetDownloadedRounds": safe_boolean_map(body.get("datasetDownloadedRounds")),
                    "offlineBonusClaimed": safe_boolean_map(body.get("offlineBonusClaimed")),
                    "round2GrantApplied": bool(body.get("round2GrantApplied")),
                    "activeFlash": safe_active_flash(body.get("activeFlash")),
                }
                save_team(db, team)
                return json_response({"team": public_team(team)})
            except Exception:
                return json_response({"error": "Could not save team. Check MONGODB_URI."}, 503)

        if route == "team/activity":
            team_id = clean_text(body.get("teamId"), 80)
            kind = clean_text(body.get("kind"), 48)
            if not team_id or not kind:
                return json_response({"error": "Team and activity type are required."}, 400)
            if not team_authorized(request, team_id):
                return json_response({"error": "Team sign-in required. Enter the team PIN again."}, 401)
            try:
                db = mongo_database()
                append_activity(db, team_id, kind, clean_text(body.get("detail"), 220))
                db.data_tycoon_teams.update_one(
                    {"_id": team_key(team_id)}, {"$set": {"lastSeenEpoch": time.time()}}
                )
                return json_response({"ok": True}, 202)
            except Exception:
                return json_response({"error": "Could not save activity. Check MONGODB_URI."}, 503)

        if route == "team/heartbeat":
            team_id = clean_text(body.get("teamId"), 80)
            if not team_id:
                return json_response({"error": "A team name is required."}, 400)
            if not team_authorized(request, team_id):
                return json_response({"error": "Team sign-in required. Enter the team PIN again."}, 401)
            try:
                db = mongo_database()
                db.data_tycoon_teams.update_one(
                    {"_id": team_key(team_id)}, {"$set": {"lastSeenEpoch": time.time()}}
                )
                return json_response({"ok": True})
            except Exception:
                return json_response({"error": "Could not update team status. Check MONGODB_URI."}, 503)

    if method == "PATCH" and route == "admin/settings/flash-timer":
        if not admin_authorized(request):
            return json_response({"error": "Organizer sign-in required."}, 401)
        try:
            body = await request_json(request)
        except (ValueError, json.JSONDecodeError) as error:
            return json_response({"error": str(error)}, 400)
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            return json_response({"error": "Timer enabled must be true or false."}, 400)
        try:
            db = mongo_database()
            existing = db.data_tycoon_settings.find_one({"_id": "flash-timer"}) or {}
            changed_at = int(time.time() * 1000) if bool(existing.get("enabled", False)) != enabled else int(existing.get("changedAt", 0))
            db.data_tycoon_settings.update_one(
                {"_id": "flash-timer"},
                {"$set": {"enabled": enabled, "changedAt": changed_at}},
                upsert=True,
            )
            return json_response({"enabled": enabled, "changedAt": changed_at})
        except Exception:
            return json_response({"error": "Could not update flash timer settings."}, 503)

    if method == "PATCH" and route.startswith("admin/teams/") and route.endswith("/money"):
        if not admin_authorized(request):
            return json_response({"error": "Organizer sign-in required."}, 401)
        try:
            body = await request_json(request)
            amount = float(body.get("companyValue"))
            if not math.isfinite(amount) or not 0 <= amount <= 10**12:
                raise ValueError("Money must be between ₹0 and ₹1,000,000,000,000.")
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            return json_response({"error": str(error)}, 400)
        requested_id = unquote(route[len("admin/teams/"):-len("/money")])
        key = team_key(requested_id)
        try:
            db = mongo_database()
            team = load_team(db, key)
            if not team:
                return json_response({"error": "Team not found."}, 404)
            old_amount = team["companyValue"]
            team["companyValue"] = round(amount)
            team["moneyRevision"] = int(team.get("moneyRevision", 0)) + 1
            team["adminOverride"] = True
            team["updatedAt"] = utc_now()
            append_activity(
                db,
                team["teamId"],
                "organizer-money-edit",
                f"Organizer changed balance from ₹{old_amount:,.0f} to ₹{team['companyValue']:,.0f}.",
                "organizer",
            )
            save_team(db, team)
            return json_response(public_team(team))
        except Exception:
            return json_response({"error": "Could not update the team balance. Check MONGODB_URI."}, 503)

    if method not in {"GET", "POST", "PATCH", "OPTIONS"}:
        return json_response({"error": "Method not allowed."}, 405)
    return json_response({"error": "API route not found."}, 404)


@app.api_route("/", methods=["GET", "POST", "PATCH", "OPTIONS"])
@app.api_route("/{path:path}", methods=["GET", "POST", "PATCH", "OPTIONS"])
async def vercel_api(request: Request, path: str = ""):
    try:
        return await handle_api(request)
    except Exception:
        return json_response({"error": "Unexpected API error."}, 500)
