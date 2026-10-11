"""Print the organizer console URL.

The console lives at a secret path. If ADMIN_CONSOLE_PATH is set in the hosting
environment, that is the path. Otherwise the path is derived from
ADMIN_SESSION_SECRET (or ADMIN_PASSWORD when no session secret is set), so it is
never written into this public repository. Run this on your own computer:

    python scripts/console_url.py
    python scripts/console_url.py --domain https://data-tycoon-website.vercel.app

Nothing is sent anywhere; the values you type are only used locally.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac


def derived_console_path(secret: str) -> str:
    # Must match api/index.py derived_console_path().
    digest = hmac.new(secret.encode(), b"data-tycoon-organizer-console-v1", hashlib.sha256).hexdigest()
    return f"ops-{digest[:24]}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", default="https://data-tycoon-website.vercel.app")
    args = parser.parse_args()
    print("Use the exact values from your hosting environment variables (Vercel: Settings > Environment Variables).")
    secret = getpass.getpass("ADMIN_SESSION_SECRET (press Enter if you never set one): ").strip()
    if not secret:
        secret = getpass.getpass("ADMIN_PASSWORD: ").strip()
    if not secret:
        raise SystemExit("A secret is required.")
    print(f"\nOrganizer console: {args.domain.rstrip('/')}/{derived_console_path(secret)}/")
    print("Keep this URL private. If you set ADMIN_CONSOLE_PATH, the console is at /<that value>/ instead.")


if __name__ == "__main__":
    main()
