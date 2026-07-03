"""Credentials access: reads the bot's .env at call time (single source of
truth shared with the Node bot; nothing is cached or duplicated here)."""

from __future__ import annotations

from pathlib import Path

ENV_PATH = Path("/home/marko_mald/Downloads/marcobot/.env")


def env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    return values
