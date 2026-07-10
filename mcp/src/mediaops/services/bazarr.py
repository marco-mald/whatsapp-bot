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
                    "sonarrSeriesId": e.get("sonarrSeriesId"),
                    "missing": [s["name"] for s in e.get("missing_subtitles", [])],
                }
                for e in episodes.get("data", [])
            ],
        },
    }


async def movie_subtitle_status(radarr_id: int) -> dict:
    """Current subtitle state for one movie: languages already present vs
    still missing (per Bazarr's configured profile), straight from Bazarr's
    own per-item record — not the wanted-list, so it reflects reality even
    for items that aren't in the wanted queue for any reason."""
    data = await _request("GET", "/movies", {"radarrid[]": radarr_id})
    items = data.get("data", [])
    if not items:
        return {"found": False, "present": [], "missing": []}
    m = items[0]
    return {
        "found": True,
        "present": [s["name"] for s in m.get("subtitles", [])],
        "missing": [s["name"] for s in m.get("missing_subtitles", [])],
    }


async def series_subtitle_status(sonarr_series_id: int) -> dict:
    """Current subtitle state for a whole series, aggregated across every
    downloaded episode: union of languages present anywhere vs still missing
    on at least one episode."""
    data = await _request("GET", "/episodes", {"seriesid[]": sonarr_series_id})
    items = data.get("data", [])
    if not items:
        return {"found": False, "present": [], "missing": []}
    present: set[str] = set()
    missing: set[str] = set()
    for ep in items:
        present.update(s["name"] for s in ep.get("subtitles", []))
        missing.update(s["name"] for s in ep.get("missing_subtitles", []))
    return {"found": True, "present": sorted(present), "missing": sorted(missing)}


async def search_movie(radarr_id: int) -> str:
    # Bazarr's action is "search-missing" ("search" returns 400)
    await _request("PATCH", "/movies", {"action": "search-missing", "radarrid": radarr_id})
    return f"subtitle search triggered for movie radarrId={radarr_id}"


async def search_series(sonarr_series_id: int) -> str:
    # Bazarr has no per-episode search action; series-level search-missing
    # covers every episode of the series that lacks subtitles.
    await _request("PATCH", "/series", {"action": "search-missing", "seriesid": sonarr_series_id})
    return f"subtitle search triggered for all missing episodes of seriesId={sonarr_series_id}"
