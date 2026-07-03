"""Preference memory: small persistent notes the agent saves across sessions
(preferred qualities, languages, per-user habits). Stored as JSON next to the
bot's other data files."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

STORE = Path("/home/marko_mald/Downloads/marcobot/data/preferences.json")
MAX_NOTES = 100


def _load() -> list[dict]:
    try:
        return json.loads(STORE.read_text())
    except (OSError, json.JSONDecodeError):
        return []


def recall() -> list[dict]:
    return _load()


def save(note: str) -> str:
    notes = _load()
    notes.append({"date": date.today().isoformat(), "note": note.strip()})
    notes = notes[-MAX_NOTES:]
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(notes, ensure_ascii=False, indent=1))
    return f"saved ({len(notes)} notes total)"


def forget(index: int) -> str:
    notes = _load()
    if not 0 <= index < len(notes):
        return f"index out of range (0-{len(notes) - 1})"
    removed = notes.pop(index)
    STORE.write_text(json.dumps(notes, ensure_ascii=False, indent=1))
    return f"removed: {removed['note'][:60]}"
