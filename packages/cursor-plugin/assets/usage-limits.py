#!/usr/bin/env python3
"""Fetch Cursor usage with credentials created by `cursor-agent login`."""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

USAGE_URL = "https://cursor.com/api/usage-summary"
MAX_RESPONSE_BYTES = 1024 * 1024
USER_ID_PATTERN = re.compile(r"user_[A-Za-z0-9_]+")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def nested_auth_values(value: dict[str, Any]) -> list[dict[str, Any]]:
    values = [value]
    for key in ("authInfo", "auth_info", "credentials", "oauth"):
        nested = value.get(key)
        if isinstance(nested, dict):
            values.append(nested)
    return values


def string_value(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def first_auth_value(documents: list[dict[str, Any]], keys: tuple[str, ...]) -> str | None:
    for document in documents:
        for container in nested_auth_values(document):
            for key in keys:
                value = string_value(container.get(key))
                if value:
                    return value
    return None


def config_paths() -> list[Path]:
    home = Path.home()
    xdg_config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    return [
        home / ".cursor" / "cli-config.json",
        home / ".cursor" / "auth.json",
        xdg_config / "cursor" / "cli-config.json",
        xdg_config / "cursor" / "auth.json",
    ]


def read_documents() -> list[dict[str, Any]]:
    return [document for path in config_paths() if (document := read_json(path)) is not None]


def read_user_id(documents: list[dict[str, Any]]) -> str | None:
    raw = first_auth_value(documents, ("authId", "auth_id", "userId", "user_id"))
    if not raw:
        return None
    match = USER_ID_PATTERN.search(raw)
    return match.group(0) if match else raw


def read_macos_keychain(service: str) -> str | None:
    attempts = [
        ["/usr/bin/security", "find-generic-password", "-s", service, "-a", "cursor-user", "-w"],
        ["/usr/bin/security", "find-generic-password", "-s", service, "-w"],
    ]
    for command in attempts:
        result = subprocess.run(command, capture_output=True, check=False, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return None


def read_access_token(documents: list[dict[str, Any]]) -> str | None:
    if platform.system() == "Darwin":
        token = read_macos_keychain("cursor-access-token")
        if token:
            return token
    return first_auth_value(
        documents,
        ("accessToken", "access_token", "access", "sessionToken", "session_token"),
    )


def unavailable(message: str) -> None:
    print(
        json.dumps(
            {
                "status": "unavailable",
                "reason": "authentication-required",
                "message": message,
            }
        )
    )


def fetch_usage(user_id: str, access_token: str) -> dict[str, Any]:
    cookie = urllib.parse.quote(f"{user_id}::{access_token}", safe="")
    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Accept": "application/json",
            "Cookie": f"WorkosCursorSessionToken={cookie}",
        },
    )
    opener = urllib.request.build_opener(NoRedirectHandler())
    with opener.open(request, timeout=15) as response:
        payload = response.read(MAX_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RESPONSE_BYTES:
        raise RuntimeError("Cursor usage response exceeded size limit")
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise RuntimeError("Cursor usage response was not an object")
    return value


def main() -> int:
    documents = read_documents()
    user_id = read_user_id(documents)
    access_token = read_access_token(documents)
    if not user_id or not access_token:
        unavailable("Run `cursor-agent login` to load Cursor usage limits.")
        return 0

    try:
        print(json.dumps(fetch_usage(user_id, access_token), separators=(",", ":")))
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            unavailable("Cursor login expired. Run `cursor-agent login` again.")
            return 0
        print(f"Cursor usage API returned HTTP {error.code}", file=sys.stderr)
        return 3
    except (OSError, ValueError, RuntimeError, urllib.error.URLError) as error:
        print(f"Cursor usage request failed: {error}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
