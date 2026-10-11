"""Test fixtures. Requires a MongoDB server (default mongodb://127.0.0.1:27017):

    docker run -d --name data-tycoon-mongo -p 27017:27017 mongo:7
    pip install -r requirements-dev.txt
    pytest
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

CONSOLE = "ops-test-console-path-123"
os.environ.update({
    "ADMIN_PASSWORD": "test-password",
    "ADMIN_SESSION_SECRET": "test-secret-for-signing-0123456789",
    "ADMIN_CONSOLE_PATH": CONSOLE,
    "MONGODB_URI": os.environ.get("TEST_MONGODB_URI", "mongodb://127.0.0.1:27017"),
    "MONGODB_DATABASE": f"dt_test_{uuid.uuid4().hex[:8]}",
    "DATA_TYCOON_SERVE_STATIC": "1",
})

from fastapi.testclient import TestClient  # noqa: E402

from api import index as api  # noqa: E402


@pytest.fixture()
def client():
    database = api.db()
    database.client.drop_database(database.name)
    api._indexes_ready = False
    api._cache.clear()
    os.environ.pop("ADMIN_ALLOWED_IPS", None)
    with TestClient(api.app) as test_client:
        yield test_client
    database.client.drop_database(database.name)


@pytest.fixture()
def db(client):
    return api.db()


def connect(client, name="Team Alpha", pin="1234"):
    response = client.post("/api/team/connect", json={"teamId": name, "pin": pin})
    assert response.status_code == 200, response.text
    data = response.json()
    return {"Authorization": f"Team {data['token']}"}, data["state"]


def admin_headers(client):
    response = client.post("/api/admin/login", json={"password": "test-password"}, headers={"X-Console-Key": CONSOLE})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}", "X-Console-Key": CONSOLE}


def set_settings(client, **values):
    response = client.patch("/api/admin/settings", json=values, headers=admin_headers(client))
    assert response.status_code == 200, response.text
    return response.json()


def ready_round(client, headers):
    """Open and finish the flash, then download the dataset for the current round."""
    assert client.post("/api/team/flash/open", headers=headers).status_code == 200
    assert client.post("/api/team/flash/close", headers=headers).status_code == 200
    assert client.get("/api/team/dataset", headers=headers).status_code == 200
    return client.get("/api/team/state", headers=headers).json()


def even_split(state):
    budget, params = state["budget"], state["parameters"]
    share = budget // len(params)
    allocations = {name: share for name in params}
    allocations[params[0]] += budget - share * len(params)
    return allocations
