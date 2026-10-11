from __future__ import annotations

import threading

from conftest import CONSOLE, admin_headers, connect, even_split, ready_round, set_settings

from api import _rules as rules
from api import index as api


# ── Site, private content and headers ───────────────────────────────────────

def test_public_site_served_and_private_files_hidden(client):
    assert client.get("/").status_code == 200
    assert client.get("/src/app.js").status_code == 200
    for path in [
        "/api/_rules.py", "/api/index.py", "/api/_private/console/admin.html", "/admin.html", "/server.py",
        "/content-src/flashes/flash-1.pdf", "/data/flashes/flash-1.pdf", "/.env", "/src/../../api/_rules.py",
        "/src/%2e%2e/%2e%2e/api/_rules.py", "/api/_private/datasets/flash1/pharma.csv",
    ]:
        response = client.get(path)
        assert response.status_code == 404, path
        assert "RANKS" not in response.text


def test_answer_key_not_in_public_assets():
    public = api.PUBLIC_DIR
    text = "".join(path.read_text(encoding="utf-8") for path in public.rglob("*") if path.suffix in {".js", ".html", ".css"})
    assert "2.7" not in text and "Multipliers" not in text
    assert "Production & Manufacturing" not in text  # parameter names come from the API


def test_security_headers(client):
    response = client.get("/")
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get("/api/health").headers["cache-control"] == "no-store"


def test_vercel_route_parameter(client):
    assert client.get("/api", params={"route": "health"}).json()["ok"] is True
    assert client.get("/api", params={"route": f"__site/{CONSOLE}/"}).status_code == 200
    assert client.get("/api", params={"route": "__site/admin.html"}).status_code == 404


# ── Team sign-in ─────────────────────────────────────────────────────────────

def test_connect_creates_team_and_checks_pin(client):
    headers, state = connect(client, "Team Alpha", "1234")
    assert state["companyValue"] == rules.BASE_BUDGET and state["industry"] == ""
    assert {item["industry"] for item in state["industryCapacity"]} == set(rules.INDUSTRIES)
    # Same team, different case and spacing, correct PIN.
    _, again = connect(client, "  team   ALPHA ", "1234")
    assert again["teamId"] == "Team Alpha"
    wrong = client.post("/api/team/connect", json={"teamId": "Team Alpha", "pin": "9999"})
    assert wrong.status_code == 401
    assert "pinHash" not in wrong.text


def test_team_name_and_pin_validation(client):
    assert client.post("/api/team/connect", json={"teamId": "<script>", "pin": "1234"}).status_code == 400
    assert client.post("/api/team/connect", json={"teamId": "Team", "pin": "12"}).status_code == 400
    assert client.post("/api/team/connect", json={"teamId": "x", "pin": "1234"}).status_code == 400


def test_pin_brute_force_is_rate_limited(client):
    connect(client, "Target", "1234")
    statuses = [client.post("/api/team/connect", json={"teamId": "Target", "pin": f"00{i:02d}"}).status_code for i in range(12)]
    assert statuses[:10] == [401] * 10
    assert statuses[10:] == [429, 429]
    # Even the right PIN is refused while locked.
    assert client.post("/api/team/connect", json={"teamId": "Target", "pin": "1234"}).status_code == 429


def test_requests_need_a_valid_token(client):
    assert client.get("/api/team/state").status_code == 401
    headers, _ = connect(client)
    token = headers["Authorization"].split(" ", 1)[1]
    payload, signature = token.split(".")
    assert client.get("/api/team/state", headers={"Authorization": f"Team {payload}x.{signature}"}).status_code == 401
    assert client.get("/api/team/state", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    # A team token is never accepted as an organizer token.
    assert client.get("/api/admin/dashboard", headers={"Authorization": f"Bearer {token}", "X-Console-Key": CONSOLE}).status_code == 401


def test_old_client_write_endpoints_are_gone(client):
    headers, _ = connect(client)
    response = client.post("/api/team/sync", json={"teamId": "Team Alpha", "companyValue": 10**12, "round": 4}, headers=headers)
    assert response.status_code == 404
    assert client.get("/api/team/state", headers=headers).json()["companyValue"] == rules.BASE_BUDGET


# ── Industry ─────────────────────────────────────────────────────────────────

def test_industry_lock(client):
    headers, _ = connect(client)
    state = client.post("/api/team/industry", json={"industry": "Pharma"}, headers=headers).json()
    assert state["industry"] == "Pharma" and len(state["parameters"]) == 10
    assert client.post("/api/team/industry", json={"industry": "Food"}, headers=headers).status_code == 409
    assert client.post("/api/team/industry", json={"industry": "Pharma"}, headers=headers).status_code == 200
    assert client.post("/api/team/industry", json={"industry": "Mining"}, headers=headers).status_code == 400


def test_industry_capacity_is_enforced_under_concurrency(client, db):
    teams = [connect(client, f"Team {i:02d}")[0] for i in range(25)]
    results = []

    def choose(headers):
        results.append(client.post("/api/team/industry", json={"industry": "Food"}, headers=headers).status_code)

    threads = [threading.Thread(target=choose, args=(headers,)) for headers in teams]
    [thread.start() for thread in threads]
    [thread.join() for thread in threads]
    assert results.count(200) == rules.INDUSTRY_CAPACITY
    assert results.count(409) == 5
    assert db.data_tycoon_teams.count_documents({"industry": "Food"}) == rules.INDUSTRY_CAPACITY
    api._cache.clear()
    food = next(item for item in client.get("/api/industry-capacity").json() if item["industry"] == "Food")
    assert food["remaining"] == 0


# ── Flash and dataset gating ─────────────────────────────────────────────────

def test_flash_and_dataset_are_gated(client, db):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Food"}, headers=headers)
    assert client.get("/api/team/flash/page/1", headers=headers).status_code == 403
    assert client.get("/api/team/flash/page/1?round=2", headers=headers).status_code == 403
    assert client.get("/api/team/dataset", headers=headers).status_code == 403

    set_settings(client, flashTimer=True)
    state = client.post("/api/team/flash/open", headers=headers).json()
    assert state["activeFlash"]["round"] == 1 and state["activeFlash"]["remainingMs"] > 290_000
    page = client.get("/api/team/flash/page/1", headers=headers)
    assert page.status_code == 200 and page.headers["content-type"] == "image/webp"
    assert client.get("/api/team/flash/page/2?round=2", headers=headers).status_code == 403
    assert client.get("/api/team/flash/page/99", headers=headers).status_code == 404

    early = client.post("/api/team/flash/close", headers=headers)
    assert early.status_code == 409 and early.json()["remainingMs"] > 0
    assert client.get("/api/team/dataset", headers=headers).status_code == 403

    # Five minutes later (the timer counts from the later of opening and switching it on).
    past = api.now_ms() - rules.FLASH_DURATION_MS
    db.data_tycoon_teams.update_one({"teamId": "Team Alpha"}, {"$set": {"activeFlash.startedAt": past}})
    db.data_tycoon_settings.update_one({"_id": "flash-timer"}, {"$set": {"changedAt": past}})
    api._cache.clear()
    done = client.post("/api/team/flash/close", headers=headers).json()
    assert done["flashCompleted"] is True and done["activeFlash"] is None
    dataset = client.get("/api/team/dataset", headers=headers)
    assert dataset.status_code == 200 and dataset.content[:2] == b"PK"  # Food round 1 is an Excel file
    assert "attachment" in dataset.headers["content-disposition"]
    assert client.get("/api/team/state", headers=headers).json()["datasetDownloaded"] is True


def test_timer_off_allows_closing_at_once_and_turning_it_on_restarts(client):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Education"}, headers=headers)
    client.post("/api/team/flash/open", headers=headers)
    set_settings(client, flashTimer=True)
    state = client.get("/api/team/state", headers=headers).json()
    assert state["activeFlash"]["remainingMs"] > 295_000
    set_settings(client, flashTimer=False)
    assert client.post("/api/team/flash/close", headers=headers).json()["flashCompleted"] is True


# ── Scoring ──────────────────────────────────────────────────────────────────

def test_scoring_rules_match_the_original_game():
    params = rules.PARAMETERS["Food"]
    assert rules.score_round("Food", 1, 1_000_000, {name: 100_000 for name in params})["payout"] == 996_000
    # Over 80% in the zero-return parameter eliminates the team.
    zero = rules.RANKS["Food"][0][-1]
    heavy = {name: 2_000 for name in params}
    heavy[zero] = 1_000_000 - 2_000 * 9
    outcome = rules.score_round("Food", 1, 1_000_000, heavy)
    assert outcome["eliminated"] and outcome["payout"] == 0
    # Over 40% in the 0.3 parameter becomes a direct loss.
    trap = rules.RANKS["Food"][0][-2]
    loss = {name: 50_000 for name in params}
    loss[trap] = 550_000
    assert rules.score_round("Food", 1, 1_000_000, loss)["returns"][trap] == -495_000
    # 2.7 parameter bands.
    assert rules.effective_multiplier(2.7, 20)[0] == 2.7 * 0.8
    assert rules.effective_multiplier(2.7, 30)[0] == 2.7
    assert rules.effective_multiplier(2.7, 90)[0] == 2.7 * 0.6


def test_every_industry_round_has_a_complete_ranking_and_dataset():
    for industry in rules.INDUSTRIES:
        for round_number in range(1, rules.ROUNDS + 1):
            assert sorted(rules.RANKS[industry][round_number - 1]) == sorted(rules.PARAMETERS[industry])
            assert (api.DATASET_DIR / rules.dataset_filename(industry, round_number)).is_file()
        assert api.flash_pages(1) > 0


def test_submit_validation(client):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Electronics"}, headers=headers)
    state = client.get("/api/team/state", headers=headers).json()
    allocations = even_split(state)
    assert client.post("/api/team/submit", json={"round": 1, "allocations": allocations}, headers=headers).status_code == 409
    state = ready_round(client, headers)

    def submit(values, round_number=1):
        return client.post("/api/team/submit", json={"round": round_number, "allocations": values}, headers=headers)

    first = state["parameters"][0]
    assert submit({**allocations, first: allocations[first] + 1}).status_code == 400  # wrong total
    low = dict(allocations)
    low[first] = 999
    low[state["parameters"][1]] += allocations[first] - 999
    assert "at least" in submit(low).json()["error"]
    assert submit({**allocations, first: allocations[first] + 0.5}).status_code == 400
    assert submit({**allocations, "Free money": 0}).status_code == 400
    assert submit(allocations, round_number=2).status_code == 409
    ok = submit(allocations)
    assert ok.status_code == 200
    body = ok.json()
    assert body["submitted"] and body["history"][0]["payout"] == body["companyValue"]
    assert submit(allocations).status_code == 409  # only once


# ── Rounds ───────────────────────────────────────────────────────────────────

def test_round_wait_and_bonus(client):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Travel and Auto"}, headers=headers)
    state = ready_round(client, headers)
    after = client.post("/api/team/submit", json={"round": 1, "allocations": even_split(state)}, headers=headers).json()
    assert after["roundWaitRemainingMs"] > 29 * 60 * 1000
    blocked = client.post("/api/team/advance", json={"round": 1}, headers=headers)
    assert blocked.status_code == 409
    set_settings(client, roundWait=False)
    opened = client.post("/api/team/advance", json={"round": 1}, headers=headers).json()
    assert opened["round"] == 2 and opened["budget"] == after["companyValue"] + rules.ROUND_BONUS
    # Advancing twice (e.g. from a second tab) is harmless.
    assert client.post("/api/team/advance", json={"round": 1}, headers=headers).json()["round"] == 2


def test_full_game_and_finish(client):
    set_settings(client, roundWait=False)
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Pharma"}, headers=headers)
    for round_number in range(1, 5):
        state = ready_round(client, headers)
        assert state["round"] == round_number
        result = client.post("/api/team/submit", json={"round": round_number, "allocations": even_split(state)}, headers=headers).json()
        if round_number < 4:
            assert client.post("/api/team/advance", json={"round": round_number}, headers=headers).status_code == 200
    final = client.get("/api/team/state", headers=headers).json()
    assert final["finished"] and len(final["history"]) == 4 and final["companyValue"] == result["companyValue"]
    assert client.post("/api/team/flash/open", headers=headers).status_code == 409
    assert client.post("/api/team/advance", json={"round": 4}, headers=headers).status_code == 409


def test_balance_change_between_view_and_submit_is_rejected(client):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Food"}, headers=headers)
    state = ready_round(client, headers)
    admin = admin_headers(client)
    client.patch("/api/admin/team-balance", json={"teamKey": "team alpha", "companyValue": 2_000_000}, headers=admin)
    stale = client.post("/api/team/submit", json={"round": 1, "allocations": even_split(state)}, headers=headers)
    assert stale.status_code == 400 and stale.json()["budget"] == 2_000_000
    fresh = client.get("/api/team/state", headers=headers).json()
    assert fresh["moneyRevision"] == 1 and fresh["budget"] == 2_000_000
    assert client.post("/api/team/submit", json={"round": 1, "allocations": even_split(fresh)}, headers=headers).status_code == 200


def test_legacy_team_documents_still_load(client, db):
    headers, _ = connect(client, "Legacy Team", "1234")
    db.data_tycoon_teams.update_one({"teamId": "Legacy Team"}, {"$set": {
        "industry": "Food", "flashCompletedRounds": {"1": True}, "datasetDownloadedRounds": {"Food-1": True},
        "history": [{"round": 1, "finalPayout": 1_200_000, "roundBudget": 1_000_000, "investedAmounts": {}, "departmentRevenues": {}}],
        "activeFlash": {"id": "flash-1", "startedAt": 1, "duration": 300000},
    }})
    state = client.get("/api/team/state", headers=headers).json()
    assert state["flashCompleted"] and state["datasetDownloaded"] and state["submitted"]
    assert state["history"][0]["payout"] == 1_200_000 and state["activeFlash"]["round"] == 1


# ── Activity ─────────────────────────────────────────────────────────────────

def test_activity_allowlist_and_throttle(client, db):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Food"}, headers=headers)
    assert client.post("/api/team/activity", json={"kind": "made-up"}, headers=headers).status_code == 400
    for _ in range(40):
        client.post("/api/team/activity", json={"kind": "tab-hidden", "detail": "x" * 500}, headers=headers)
    stored = list(db.data_tycoon_activities.find({"kind": "tab-hidden"}))
    assert len(stored) <= api.ACTIVITY_LIMIT_PER_MINUTE
    assert all(len(row["detail"]) <= 240 and row["industry"] == "Food" for row in stored)


# ── Organizer console ────────────────────────────────────────────────────────

def test_console_is_hidden_without_the_secret_path(client):
    assert client.get("/admin").status_code == 404
    assert client.get("/admin.html").status_code == 404
    assert client.get(f"/{CONSOLE}/").status_code == 200
    assert client.get(f"/{CONSOLE}/admin.js").status_code == 200
    assert client.get(f"/{CONSOLE}", follow_redirects=False).status_code == 308
    assert client.get(f"/{CONSOLE}/").headers["x-robots-tag"].startswith("noindex")
    assert client.post("/api/admin/login", json={"password": "test-password"}).status_code == 404
    assert client.post("/api/admin/login", json={"password": "test-password"}, headers={"X-Console-Key": "guess"}).status_code == 404
    assert client.post("/api/admin/login", json={"password": "nope"}, headers={"X-Console-Key": CONSOLE}).status_code == 401
    assert "admin" not in client.get("/").text.lower()


def test_console_path_defaults_to_a_secret_derived_path(client, monkeypatch):
    monkeypatch.setenv("ADMIN_CONSOLE_PATH", "")
    derived = api.derived_console_path("test-secret-for-signing-0123456789")
    assert derived.startswith("ops-") and len(derived) == 28
    assert client.get(f"/{CONSOLE}/").status_code == 404
    assert client.get(f"/{derived}/").status_code == 200
    assert client.post("/api/admin/login", json={"password": "test-password"}, headers={"X-Console-Key": derived}).status_code == 200
    # The helper script computes the same path.
    import importlib.util
    spec = importlib.util.spec_from_file_location("console_url", api.API_DIR.parent / "scripts" / "console_url.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    assert script.derived_console_path("test-secret-for-signing-0123456789") == derived


def test_console_disabled_when_path_is_invalid(client, monkeypatch):
    monkeypatch.setenv("ADMIN_CONSOLE_PATH", "short")
    assert client.get("/short/").status_code == 404
    assert client.post("/api/admin/login", json={"password": "test-password"}, headers={"X-Console-Key": "short"}).status_code == 404


def test_only_one_device_per_team(client):
    laptop, _ = connect(client, "Solo Team", "1234")
    assert client.get("/api/team/state", headers=laptop).status_code == 200
    other, _ = connect(client, "solo team", "1234")
    kicked = client.get("/api/team/state", headers=laptop)
    assert kicked.status_code == 401 and "another device" in kicked.json()["error"]
    assert client.get("/api/team/state", headers=other).status_code == 200
    # A wrong PIN elsewhere does not sign the real device out.
    assert client.post("/api/team/connect", json={"teamId": "Solo Team", "pin": "9999"}).status_code == 401
    assert client.get("/api/team/state", headers=other).status_code == 200


def test_balance_never_goes_negative(client, db):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Food"}, headers=headers)
    state = ready_round(client, headers)
    trap = rules.RANKS["Food"][0][-2]  # 0.3 parameter: over 40% becomes -0.9
    allocations = {name: 1_000 for name in state["parameters"]}
    allocations[trap] = state["budget"] - 9_000
    result = client.post("/api/team/submit", json={"round": 1, "allocations": allocations}, headers=headers).json()
    assert result["history"][0]["payout"] < 0 and result["companyValue"] == 0


def test_vercel_extra_path_parameter_is_ignored(client):
    assert client.get("/api", params={"route": "health", "path": "health"}).json()["ok"] is True
    headers = admin_headers(client)
    data = client.get("/api", params={"route": "admin/dashboard", "path": "admin/dashboard", "kind": "all"}, headers=headers).json()
    assert "teams" in data


def test_console_ip_allowlist(client, monkeypatch):
    monkeypatch.setenv("ADMIN_ALLOWED_IPS", "203.0.113.0/24")
    assert client.get(f"/{CONSOLE}/").status_code == 404
    assert client.get(f"/{CONSOLE}/", headers={"X-Forwarded-For": "203.0.113.7"}).status_code == 200


def test_admin_login_rate_limit(client):
    statuses = [client.post("/api/admin/login", json={"password": "x"}, headers={"X-Console-Key": CONSOLE}).status_code for _ in range(10)]
    assert statuses[:8] == [401] * 8 and statuses[8:] == [429, 429]


def test_admin_dashboard_balance_and_pin_reset(client):
    headers, _ = connect(client)
    client.post("/api/team/industry", json={"industry": "Food"}, headers=headers)
    client.post("/api/team/activity", json={"kind": "screenshot-suspected", "detail": "Cmd+Shift"}, headers=headers)
    admin = admin_headers(client)
    dashboard = client.get("/api/admin/dashboard", headers=admin).json()
    assert dashboard["teams"][0]["teamId"] == "Team Alpha" and dashboard["teams"][0]["online"]
    assert "pinHash" not in str(dashboard)
    assert [item["kind"] for item in dashboard["activities"]] == ["screenshot-suspected"]
    assert dashboard["recentAlerts"] == 1
    filtered = client.get("/api/admin/dashboard", params={"industry": "Pharma"}, headers=admin).json()
    assert filtered["activities"] == []
    everything = client.get("/api/admin/dashboard", params={"kind": "all"}, headers=admin).json()
    assert {"team-connected", "industry-locked"} <= {item["kind"] for item in everything["activities"]}

    assert client.patch("/api/admin/team-balance", json={"teamKey": "team alpha", "companyValue": -5}, headers=admin).status_code == 400
    assert client.patch("/api/admin/team-balance", json={"teamKey": "team alpha", "companyValue": 1_500_000}, headers=admin).status_code == 200
    assert client.get("/api/team/state", headers=headers).json()["companyValue"] == 1_500_000

    assert client.post("/api/admin/team-reset-pin", json={"teamKey": "team alpha"}, headers=admin).status_code == 200
    assert client.get("/api/team/state", headers=headers).status_code == 401
    new_headers, state = connect(client, "Team Alpha", "new-pin-5678")
    assert state["companyValue"] == 1_500_000
    assert client.post("/api/team/connect", json={"teamId": "Team Alpha", "pin": "1234"}).status_code == 401


def test_leaderboard_order_and_fields(client):
    a, _ = connect(client, "Alpha")
    b, _ = connect(client, "Bravo")
    admin = admin_headers(client)
    client.patch("/api/admin/team-balance", json={"teamKey": "bravo", "companyValue": 2_000_000}, headers=admin)
    api._cache.clear()
    rows = client.get("/api/leaderboard").json()
    assert [row["teamId"] for row in rows] == ["Bravo", "Alpha"]
    assert set(rows[0]) == {"teamId", "industry", "round", "companyValue", "isEliminated"}


def test_payout_rounding_matches_javascript_math_round():
    assert rules.round_half_up(0.5) == 1 and rules.round_half_up(2.5) == 3 and rules.round_half_up(-0.5) == 0


def test_pins_from_the_previous_version_still_work(client, db):
    import hashlib
    salt = bytes(16)
    legacy = hashlib.pbkdf2_hmac("sha256", b"old-pin", salt, 260_000).hex()
    db.data_tycoon_teams.insert_one({**api.new_team("Old Team"), "_id": "old team", "pinSalt": salt.hex(), "pinHash": legacy})
    assert client.post("/api/team/connect", json={"teamId": "Old Team", "pin": "old-pin"}).status_code == 200
    assert client.post("/api/team/connect", json={"teamId": "Old Team", "pin": "wrong"}).status_code == 401
