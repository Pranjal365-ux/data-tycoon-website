"""Delete all teams, activity, seat counters and rate limits before the event.

Settings (flash timer, round wait) are kept. This cannot be undone.

    MONGODB_URI=... MONGODB_DATABASE=data_tycoon python scripts/reset_event_data.py --yes
"""

from __future__ import annotations

import os
import sys

from pymongo import MongoClient

COLLECTIONS = ["data_tycoon_teams", "data_tycoon_activities", "data_tycoon_industry_capacity", "data_tycoon_rate_limits"]


def main() -> int:
    uri = os.environ.get("MONGODB_URI", "")
    name = os.environ.get("MONGODB_DATABASE", "data_tycoon")
    if not uri:
        print("Set MONGODB_URI first.", file=sys.stderr)
        return 1
    db = MongoClient(uri, serverSelectionTimeoutMS=8000)[name]
    counts = {collection: db[collection].estimated_document_count() for collection in COLLECTIONS}
    print(f"Database '{name}':", ", ".join(f"{k.removeprefix('data_tycoon_')}={v}" for k, v in counts.items()))
    if "--yes" not in sys.argv:
        print("Dry run. Re-run with --yes to delete these records.")
        return 0
    for collection in COLLECTIONS:
        db[collection].delete_many({})
    print("Event data cleared.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
