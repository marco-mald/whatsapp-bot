"""Bazarr layer: missing subtitles and per-item subtitle searches."""

from __future__ import annotations

import re

import httpx

from ..inventory import ARRSTACK

BASE = "http://localhost:6767/api"
_KEY_RE = re.compile(r"^\s*apikey:\s*([0-9a-f]{16,})\s*$", re.MULTILINE)


def _key() -> str:
    text = (ARRSTACK / "bazarr" / "config" / "config.yaml").read_text()
    match = _KEY_RE.search(text)
    if not match:
        raise RuntimeError("Bazarr apikey not found in config.yaml")
    return match.group(1)


async def _request(method: str, path: str, params: dict | None = None):
    async with httpx.AsyncClient() as client:
        res = await client.request(
            method, f"{BASE}{path}", headers={"X-API-KEY": _key()},
            params=params, timeout=30.0,
        )
        res.raise_for_status()
        return res.json() if res.content else None


async def wanted(limit: int = 20) -> dict:
    movies = await _request("GET", "/movies/wanted", {"start": 0, "length": limit})
    episodes = await _request("GET", "/episodes/wanted", {"start": 0, "length": limit})
    return {
        "movies_missing_subs": {
            "total": movies.get("total", len(movies.get("data", []))),
            "items": [
                {
                    "title": m["title"],
                    "radarrId": m["radarrId"],
                    "missing": [s["name"] for s in m.get("missing_subtitles", [])],
                }
                for m in movies.get("data", [])
            ],
        },
        "episodes_missing_subs": {
            "total": episodes.get("total", len(episodes.get("data", []))),
            "items": [
                {
                    "series": e.get("seriesTitle"),
                    "episode": e.get("episode_number"),
                    "sonarrEpisodeId": e.get("sonarrEpisodeId"),
                    "missing": [s["name"] for s in e.get("missing_subtitles", [])],
                }
                for e in episodes.get("data", [])
            ],
        },
    }


async def search_movie(radarr_id: int) -> str:
    await _request("PATCH", "/movies", {"action": "search", "radarrid": radarr_id})
    return f"subtitle search triggered for movie radarrId={radarr_id}"


async def search_episode(sonarr_episode_id: int) -> str:
    await _request("PATCH", "/episodes", {"action": "search", "episodeid": sonarr_episode_id})
    return f"subtitle search triggered for episode id={sonarr_episode_id}"
