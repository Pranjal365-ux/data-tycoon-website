from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import secrets
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator
from urllib.parse import unquote

import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
MAX_ACTIVITIES = 1500


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_text(value, limit: int = 160) -> str:
    return " ".join(str(value or "").strip().split())[:limit]


def team_key(team_id: str) -> str:
    return clean_text(team_id, 80).casefold()


def database_url() -> str:
    value = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or os.environ.get("NEON_DATABASE_URL")
    if not value:
        raise RuntimeError("Set DATABASE_URL in the Vercel project environment variables.")
    if "sslmode=" not in value:
        value += ("&" if "?" in value else "?") + "sslmode=require"
    return value


@contextmanager
def database() -> Iterator[psycopg.Connection]:
    connection = psycopg.connect(database_url(), connect_timeout=8)
    try:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS data_tycoon_teams (
                 team_key TEXT PRIMARY KEY,
                 team_id TEXT NOT NULL,
                 payload JSONB NOT NULL
               )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS data_tycoon_activities (
                 sequence BIGSERIAL PRIMARY KEY,
                 team_id TEXT NOT NULL,
                 payload JSONB NOT NULL
               )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS data_tycoon_activities_team_idx ON data_tycoon_activities (lower(team_id), sequence DESC)"
        )
        connection.commit()
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def load_team(connection: psycopg.Connection, key: str) -> dict | None:
    row = connection.execute(
        "SELECT payload FROM data_tycoon_teams WHERE team_key = %s", (key,)
    ).fetchone()
    return row[0] if row else None


def save_team(connection: psycopg.Connection, team: dict) -> None:
    connection.execute(
        """INSERT INTO data_tycoon_teams (team_key, team_id, payload)
           VALUES (%s, %s, %s::jsonb)
           ON CONFLICT (team_key) DO UPDATE
           SET team_id = EXCLUDED.team_id, payload = EXCLUDED.payload""",
        (team_key(team["teamId"]), team["teamId"], json.dumps(team, ensure_ascii=False)),
    )


def append_activity(connection: psycopg.Connection, team_id: str, kind: str, detail: str, actor: str = "team") -> None:
    activity = {
        "id": secrets.token_hex(8),
        "teamId": clean_text(team_id, 80),
        "kind": clean_text(kind, 48),
        "detail": clean_text(detail, 220),
        "actor": actor,
        "timestamp": utc_now(),
    }
    connection.execute(
        "INSERT INTO data_tycoon_activities (team_id, payload) VALUES (%s, %s::jsonb)",
        (activity["teamId"], json.dumps(activity, ensure_ascii=False)),
    )
    connection.execute(
        """DELETE FROM data_tycoon_activities
           WHERE sequence NOT IN (
             SELECT sequence FROM data_tycoon_activities ORDER BY sequence DESC LIMIT %s
           )""",
        (MAX_ACTIVITIES,),
    )


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


def public_team(team: dict) -> dict:
    return {key: value for key, value in team.items() if key != "adminOverride"}


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
    return hmac.compare_digest(expected, supplied) and claims.get("exp", 0) > time.time()


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

    if method == "GET" and route == "health":
        try:
            with database() as connection:
                connection.execute("SELECT 1")
            return json_response({"ok": True, "service": "data-tycoon"})
        except Exception:
            return json_response({"ok": False, "error": "Database unavailable. Check DATABASE_URL."}, 503)

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

    if method == "GET" and route.startswith("team/"):
        requested_id = unquote(route[len("team/"):])
        try:
            with database() as connection:
                team = load_team(connection, team_key(requested_id))
            if not team:
                return json_response({"error": "Team not found."}, 404)
            return json_response({
                "teamId": team["teamId"],
                "companyValue": team["companyValue"],
                "moneyRevision": team.get("moneyRevision", 0),
            })
        except Exception:
            return json_response({"error": "Database unavailable. Check DATABASE_URL."}, 503)

    if method == "GET" and route == "admin/teams":
        if not admin_authorized(request):
            return json_response({"error": "Organizer sign-in required."}, 401)
        try:
            with database() as connection:
                rows = connection.execute("SELECT payload FROM data_tycoon_teams").fetchall()
            now = time.time()
            teams = [
                public_team(row[0]) | {"online": now - float(row[0].get("lastSeenEpoch", 0)) < 20}
                for row in rows
            ]
            teams.sort(key=lambda team: (-float(team.get("companyValue", 0)), team.get("teamId", "").casefold()))
            return json_response(teams)
        except Exception:
            return json_response({"error": "Database unavailable. Check DATABASE_URL."}, 503)

    if method == "GET" and route == "admin/activities":
        if not admin_authorized(request):
            return json_response({"error": "Organizer sign-in required."}, 401)
        filter_team = request.query_params.get("teamId", "").casefold()
        try:
            with database() as connection:
                if filter_team:
                    rows = connection.execute(
                        "SELECT payload FROM data_tycoon_activities WHERE lower(team_id) = %s ORDER BY sequence DESC LIMIT 250",
                        (filter_team,),
                    ).fetchall()
                else:
                    rows = connection.execute(
                        "SELECT payload FROM data_tycoon_activities ORDER BY sequence DESC LIMIT 250"
                    ).fetchall()
            return json_response([row[0] for row in rows])
        except Exception:
            return json_response({"error": "Database unavailable. Check DATABASE_URL."}, 503)

    if method == "POST":
        try:
            body = await request_json(request)
        except (ValueError, json.JSONDecodeError) as error:
            return json_response({"error": str(error)}, 400)

        if route == "team/sync":
            team_id = clean_text(body.get("teamId"), 80)
            if not team_id:
                return json_response({"error": "A team name is required."}, 400)
            try:
                round_number = max(1, min(4, int(body.get("round", 1))))
                balance = float(body.get("companyValue", 0))
                if not math.isfinite(balance):
                    raise ValueError
                balance = max(0, min(10**12, balance))
            except (TypeError, ValueError):
                return json_response({"error": "Invalid team balance or round."}, 400)
            try:
                with database() as connection:
                    previous = load_team(connection, team_key(team_id)) or {}
                    incoming_history = body.get("history") if isinstance(body.get("history"), list) else []
                    previous_rounds = {item.get("round") for item in previous.get("history", []) if isinstance(item, dict)}
                    has_new_result = any(
                        item.get("round") not in previous_rounds for item in incoming_history if isinstance(item, dict)
                    )
                    preserve_override = previous.get("adminOverride") and not has_new_result
                    team = {
                        **previous,
                        "teamId": team_id,
                        "industry": clean_text(body.get("industry"), 80),
                        "round": round_number,
                        "companyValue": previous.get("companyValue", balance) if preserve_override else balance,
                        "allocations": safe_allocations(body.get("allocations")),
                        "history": [
                            {
                                "round": item.get("round"),
                                "finalPayout": item.get("finalPayout", item.get("newValue", 0)),
                                "eliminated": bool(item.get("eliminated")),
                            }
                            for item in incoming_history if isinstance(item, dict)
                        ][-4:],
                        "page": clean_text(body.get("page"), 24),
                        "isEliminated": bool(body.get("isEliminated")),
                        "moneyRevision": int(previous.get("moneyRevision", 0)),
                        "adminOverride": bool(preserve_override),
                        "updatedAt": utc_now(),
                        "lastSeenEpoch": time.time(),
                    }
                    save_team(connection, team)
                return json_response({"team": public_team(team)})
            except Exception:
                return json_response({"error": "Could not save team. Check DATABASE_URL."}, 503)

        if route == "team/activity":
            team_id = clean_text(body.get("teamId"), 80)
            kind = clean_text(body.get("kind"), 48)
            if not team_id or not kind:
                return json_response({"error": "Team and activity type are required."}, 400)
            try:
                with database() as connection:
                    append_activity(connection, team_id, kind, clean_text(body.get("detail"), 220))
                    team = load_team(connection, team_key(team_id))
                    if team:
                        team["lastSeenEpoch"] = time.time()
                        save_team(connection, team)
                return json_response({"ok": True}, 202)
            except Exception:
                return json_response({"error": "Could not save activity. Check DATABASE_URL."}, 503)

        if route == "team/heartbeat":
            team_id = clean_text(body.get("teamId"), 80)
            if not team_id:
                return json_response({"error": "A team name is required."}, 400)
            try:
                with database() as connection:
                    team = load_team(connection, team_key(team_id))
                    if team:
                        team["lastSeenEpoch"] = time.time()
                        save_team(connection, team)
                return json_response({"ok": True})
            except Exception:
                return json_response({"error": "Could not update team status. Check DATABASE_URL."}, 503)

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
            with database() as connection:
                team = load_team(connection, key)
                if not team:
                    return json_response({"error": "Team not found."}, 404)
                old_amount = team["companyValue"]
                team["companyValue"] = round(amount)
                team["moneyRevision"] = int(team.get("moneyRevision", 0)) + 1
                team["adminOverride"] = True
                team["updatedAt"] = utc_now()
                append_activity(
                    connection,
                    team["teamId"],
                    "organizer-money-edit",
                    f"Organizer changed balance from ₹{old_amount:,.0f} to ₹{team['companyValue']:,.0f}.",
                    "organizer",
                )
                save_team(connection, team)
            return json_response(public_team(team))
        except Exception:
            return json_response({"error": "Could not update the team balance. Check DATABASE_URL."}, 503)

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
