"""Concurrent load test: N simulated teams play the whole game at once.

Each simulated team behaves like the real browser: it signs in, polls
/team/state every 5 s, refreshes the leaderboard every 10 s, picks an
industry, and for each round opens the flash, downloads all page images,
reports a couple of integrity events, closes the flash, downloads the dataset,
submits, and advances. One organizer console polls the dashboard every 3 s.

    python tests/load/load_test.py --base http://127.0.0.1:8000 --teams 50 \
        --console ops-... --password ...

The teams are created through the organizer API first (players cannot create
teams), and the organizer settings are switched to "timer off", "all rounds
open" and "no wait" for the run so the full game fits in a few minutes; the
request rate per team is the same as during the event.
"""

from __future__ import annotations

import argparse
import asyncio
import random
import statistics
import time
from collections import defaultdict

import httpx

INDUSTRIES = ["Food", "Electronics", "Travel and Auto", "Pharma", "Education"]
latencies: dict[str, list[float]] = defaultdict(list)
errors: dict[str, list[str]] = defaultdict(list)


async def call(client: httpx.AsyncClient, name: str, method: str, url: str, **kwargs) -> httpx.Response | None:
    start = time.perf_counter()
    try:
        try:
            response = await client.request(method, url, **kwargs)
        except (httpx.ReadError, httpx.RemoteProtocolError):
            # A reused keep-alive connection closed under us; browsers retry this once too.
            response = await client.request(method, url, **kwargs)
        latencies[name].append(time.perf_counter() - start)
        if response.status_code >= 400:
            errors[name].append(f"{response.status_code} {response.text[:120]}")
        return response
    except httpx.HTTPError as error:
        latencies[name].append(time.perf_counter() - start)
        errors[name].append(f"{type(error).__name__}: {error}")
        return None


async def poller(client, headers, stop: asyncio.Event):
    while not stop.is_set():
        await call(client, "GET /team/state (poll)", "GET", "/api/team/state", headers=headers)
        try:
            await asyncio.wait_for(stop.wait(), 5)
        except asyncio.TimeoutError:
            pass


async def leaderboard(client, stop: asyncio.Event):
    while not stop.is_set():
        await call(client, "GET /leaderboard", "GET", "/api/leaderboard")
        try:
            await asyncio.wait_for(stop.wait(), 10)
        except asyncio.TimeoutError:
            pass


async def play(base: str, index: int, run: str, think: float, results: list):
    async with httpx.AsyncClient(base_url=base, timeout=30) as client:
        await asyncio.sleep(random.random() * 3)  # teams arrive over a few seconds
        response = await call(client, "POST /team/connect", "POST", "/api/team/connect", json={"teamId": f"Load {run} {index:03d}", "pin": "4321"})
        if not response or response.status_code != 200:
            results.append(False)
            return
        headers = {"Authorization": f"Team {response.json()['token']}"}
        stop = asyncio.Event()
        background = [asyncio.create_task(poller(client, headers, stop)), asyncio.create_task(leaderboard(client, stop))]
        try:
            state = (await call(client, "POST /team/industry", "POST", "/api/team/industry", headers=headers, json={"industry": INDUSTRIES[index % 5]})).json()
            for round_number in range(1, 5):
                state = (await call(client, "POST /team/flash/open", "POST", "/api/team/flash/open", headers=headers)).json()
                await asyncio.gather(*[
                    call(client, "GET /team/flash/page", "GET", f"/api/team/flash/page/{page}?round={round_number}", headers=headers)
                    for page in range(1, state["flashPages"] + 1)
                ])
                for kind in random.sample(["tab-hidden", "window-blur", "focus-return", "screenshot-suspected"], 2):
                    await call(client, "POST /team/activity", "POST", "/api/team/activity", headers=headers, json={"kind": kind, "detail": "load test"})
                await asyncio.sleep(think * random.uniform(0.5, 1.5))
                await call(client, "POST /team/flash/close", "POST", "/api/team/flash/close", headers=headers)
                await call(client, "GET /team/dataset", "GET", "/api/team/dataset", headers=headers)
                state = (await call(client, "GET /team/state", "GET", "/api/team/state", headers=headers)).json()
                await asyncio.sleep(think * random.uniform(0.5, 1.5))
                budget, params = state["budget"], state["parameters"]
                weights = [random.random() + 0.2 for _ in params]
                spare = budget - 1000 * len(params)
                allocation = {name: 1000 + int(spare * w / sum(weights)) for name, w in zip(params, weights)}
                allocation[params[0]] += budget - sum(allocation.values())
                submit = await call(client, "POST /team/submit", "POST", "/api/team/submit", headers=headers, json={"round": round_number, "allocations": allocation})
                if not submit or submit.status_code != 200:
                    results.append(False)
                    return
                state = submit.json()
                if state["finished"]:
                    break
                await asyncio.sleep(think * random.uniform(0.2, 0.6))
                await call(client, "POST /team/advance", "POST", "/api/team/advance", headers=headers, json={"round": round_number})
            final = (await call(client, "GET /team/state", "GET", "/api/team/state", headers=headers)).json()
            results.append(final["finished"])
        finally:
            stop.set()
            await asyncio.gather(*background)


async def organizer(base: str, console: str, password: str, stop: asyncio.Event):
    async with httpx.AsyncClient(base_url=base, timeout=30) as client:
        login = await client.post("/api/admin/login", json={"password": password}, headers={"X-Console-Key": console})
        headers = {"X-Console-Key": console, "Authorization": f"Bearer {login.json()['token']}"}
        while not stop.is_set():
            await call(client, "GET /admin/dashboard", "GET", "/api/admin/dashboard?kind=alerts", headers=headers)
            try:
                await asyncio.wait_for(stop.wait(), 3)
            except asyncio.TimeoutError:
                pass


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--teams", type=int, default=50)
    parser.add_argument("--think", type=float, default=8.0, help="average seconds spent reading/deciding per step")
    parser.add_argument("--console", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()

    async with httpx.AsyncClient(base_url=args.base, timeout=30) as client:
        login = await client.post("/api/admin/login", json={"password": args.password}, headers={"X-Console-Key": args.console})
        admin = {"X-Console-Key": args.console, "Authorization": f"Bearer {login.json()['token']}"}
        await client.patch("/api/admin/settings", json={"flashTimer": False, "openRound": 4, "waitMinutes": 0, "paused": False}, headers=admin)
        run = format(int(time.time()) % 100000, "05d")
        teams = [{"teamId": f"Load {run} {i:03d}", "pin": "4321"} for i in range(args.teams)]
        for start in range(0, len(teams), 100):
            created = await client.post("/api/admin/teams", json={"teams": teams[start:start + 100]}, headers=admin, timeout=120)
            created.raise_for_status()

    results: list[bool] = []
    stop = asyncio.Event()
    console_task = asyncio.create_task(organizer(args.base, args.console, args.password, stop))
    started = time.perf_counter()
    await asyncio.gather(*[play(args.base, i, run, args.think, results) for i in range(args.teams)])
    elapsed = time.perf_counter() - started
    stop.set()
    await console_task

    total = sum(len(values) for values in latencies.values())
    print(f"\n{args.teams} teams (one device each), {elapsed:.0f} s, {total} requests ({total / elapsed:.1f} req/s average)")
    print(f"Teams that finished all rounds: {sum(results)}/{args.teams}\n")
    print(f"{'endpoint':32} {'count':>6} {'p50 ms':>8} {'p95 ms':>8} {'p99 ms':>8} {'max ms':>8} {'errors':>7}")
    for name in sorted(latencies):
        values = sorted(latencies[name])
        q = lambda p: values[min(len(values) - 1, int(p * len(values)))] * 1000
        print(f"{name:32} {len(values):>6} {statistics.median(values) * 1000:>8.0f} {q(.95):>8.0f} {q(.99):>8.0f} {values[-1] * 1000:>8.0f} {len(errors[name]):>7}")
    for name, items in errors.items():
        for item in items[:3]:
            print(f"  error {name}: {item}")
    if any(errors.values()) or sum(results) != args.teams:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
