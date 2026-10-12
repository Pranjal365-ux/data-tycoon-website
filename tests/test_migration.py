"""Upgrade test: data written by the previous production version keeps working.

Runs the previous API (tests/fixtures/legacy_api.py) against an empty database,
plays like the old browser did, then switches to the new API on the same data.
"""

from __future__ import annotations

import importlib.util
import time

from conftest import CONSOLE, admin_headers, even_split, ready_round
from fastapi.testclient import TestClient

from api import index as api

LEGACY_PATH = api.API_DIR.parent / "tests" / "fixtures" / "legacy_api.py"


def load_legacy():
    spec = importlib.util.spec_from_file_location("legacy_api", LEGACY_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def old_history_entry(round_number, budget, payout, params):
    share = budget // len(params)
    allocations = {name: share for name in params}
    return {
        "round": round_number, "allocations": allocations, "investedAmounts": allocations,
        "departmentRevenues": {name: payout / len(params) for name in params},
        "subsystemResults": {}, "previousValue": budget, "newValue": payout, "finalPayout": payout,
        "roundBudget": budget, "roundBonus": 0, "netProfit": payout - budget, "eliminated": False, "change": 10,
    }


def test_previous_version_data_upgrades_cleanly(client, db):
    legacy = load_legacy()
    params = api.rules.PARAMETERS["Food"]
    with TestClient(legacy.app) as old:
        # Team A finished Round 1 in the old version.
        token_a = old.post("/api/team/connect", json={"teamId": "Legacy Alpha", "pin": "2468"}).json()["token"]
        auth_a = {"Authorization": f"Team {token_a}"}
        assert old.post("/api/team/industry", json={"teamId": "Legacy Alpha", "industry": "Food"}, headers=auth_a).status_code == 200
        snapshot = {
            "teamId": "Legacy Alpha", "industry": "Food", "round": 1, "companyValue": 1_100_000, "valueEnteredAt": 1,
            "moneyRevision": 0, "allocations": {}, "history": [old_history_entry(1, 1_000_000, 1_100_000, params)],
            "pendingIndustry": None, "allocationRound": 1, "allocationBudget": 1_000_000, "allocationSetupVersion": 2,
            "flashCompletedRounds": {"1": True}, "datasetDownloadedRounds": {"Food-1": True},
            "offlineBonusClaimed": {"round3": False, "round4": False}, "round2GrantApplied": False,
            "roundWaitUntil": 0, "activeFlash": None, "page": "results", "isEliminated": False,
        }
        assert old.post("/api/team/sync", json=snapshot, headers=auth_a).status_code == 200
        assert old.post("/api/team/activity", json={"teamId": "Legacy Alpha", "kind": "screenshot-shortcut", "detail": "Detected Print Screen shortcut during a flash."}, headers=auth_a).status_code == 202

        # Team B was in the middle of reading Flash 1.
        token_b = old.post("/api/team/connect", json={"teamId": "Legacy Bravo", "pin": "1357"}).json()["token"]
        auth_b = {"Authorization": f"Team {token_b}"}
        old.post("/api/team/industry", json={"teamId": "Legacy Bravo", "industry": "Pharma"}, headers=auth_b)
        old.post("/api/team/sync", json={**snapshot, "teamId": "Legacy Bravo", "industry": "Pharma", "companyValue": 1_000_000, "history": [],
                                         "flashCompletedRounds": {}, "datasetDownloadedRounds": {}, "page": "game",
                                         "activeFlash": {"id": "flash-1", "startedAt": int(time.time() * 1000) - 60_000, "duration": 300_000}}, headers=auth_b)

        # Organizer settings and a balance edit from the old console.
        old_admin = {"Authorization": f"Bearer {old.post('/api/admin/login', json={'password': 'test-password'}).json()['token']}"}
        assert old.patch("/api/admin/settings/flash-timer", json={"enabled": True}, headers=old_admin).status_code == 200
        assert old.patch("/api/admin/settings/round-wait", json={"enabled": False}, headers=old_admin).status_code == 200
        assert old.patch("/api/admin/teams/Legacy%20Bravo/money", json={"companyValue": 1_050_000}, headers=old_admin).status_code == 200
        old.get("/api/admin/dashboard", headers=old_admin)  # old code creates its indexes

    old_index_names = {index["name"] for index in db.data_tycoon_activities.list_indexes()}
    assert "teamKey_1__id_-1" in old_index_names  # the index name that used to conflict

    # Switch to the new version on the same database (fresh process state).
    api._indexes_ready = False
    api._cache.clear()
    assert client.get("/api/health").status_code == 200

    # Old PINs work; old progress is understood.
    response = client.post("/api/team/connect", json={"teamId": "legacy alpha", "pin": "2468"})
    assert response.status_code == 200, response.text
    headers_a = {"Authorization": f"Team {response.json()['token']}"}
    state = response.json()["state"]
    assert state["industry"] == "Food" and state["round"] == 1 and state["submitted"]
    assert state["companyValue"] == 1_100_000 and state["history"][0]["payout"] == 1_100_000
    assert state["flashCompleted"] and state["datasetDownloaded"]
    assert state["settings"]["flashTimer"]["enabled"] is True and state["settings"]["waitMinutes"] == 0
    assert client.post("/api/team/connect", json={"teamId": "Legacy Alpha", "pin": "0000"}).status_code == 401

    # Old browser tokens are rejected cleanly (the player just signs in again).
    assert client.get("/api/team/state", headers=auth_a).status_code == 401

    # Team A continues into Round 2 (once organizers open it) with the bonus, and plays it.
    client.patch("/api/admin/settings", json={"openRound": 2}, headers=admin_headers(client))
    state = client.post("/api/team/advance", json={"round": 1}, headers=headers_a).json()
    assert state["round"] == 2 and state["budget"] == 1_100_000 + 250_000
    client.patch("/api/admin/settings", json={"flashTimer": False}, headers=admin_headers(client))
    state = ready_round(client, headers_a)
    result = client.post("/api/team/submit", json={"round": 2, "allocations": even_split(state)}, headers=headers_a)
    assert result.status_code == 200 and len(result.json()["history"]) == 2

    # Team B's open flash is restored and can be finished.
    response = client.post("/api/team/connect", json={"teamId": "Legacy Bravo", "pin": "1357"})
    headers_b = {"Authorization": f"Team {response.json()['token']}"}
    state_b = response.json()["state"]
    assert state_b["activeFlash"]["round"] == 1 and state_b["companyValue"] == 1_050_000
    assert client.post("/api/team/flash/close", headers=headers_b).json()["flashCompleted"] is True

    # The new console sees old teams and old screenshot signals.
    dashboard = client.get("/api/admin/dashboard", headers=admin_headers(client)).json()
    assert {team["teamId"] for team in dashboard["teams"]} == {"Legacy Alpha", "Legacy Bravo"}
    assert any(item["kind"] == "screenshot-shortcut" and item["teamId"] == "Legacy Alpha" for item in dashboard["activities"])
    assert client.get("/api/leaderboard").status_code == 200
    capacity = {item["industry"]: item["assigned"] for item in client.get("/api/industry-capacity").json()}
    assert capacity["Food"] == 1 and capacity["Pharma"] == 1
    assert CONSOLE  # console key fixture in use
