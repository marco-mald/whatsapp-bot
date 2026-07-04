"""Radarr/Sonarr media layer: import queues (stuck downloads) and missing media."""

from __future__ import annotations

import asyncio
import re

import httpx

from ..inventory import ARRSTACK

APPS = {
    "radarr": "http://localhost:7878/api/v3",
    "sonarr": "http://localhost:8989/api/v3",
}

_APIKEY_RE = re.compile(r"<ApiKey>([^<]+)</ApiKey>")


def _key(app: str) -> str:
    xml = (ARRSTACK / app / "config.xml").read_text()
    return _APIKEY_RE.search(xml).group(1)


async def _get(app: str, path: str, params: dict | None = None):
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{APPS[app]}{path}",
            headers={"X-Api-Key": _key(app)},
            params=params,
            timeout=15.0,
        )
        res.raise_for_status()
        return res.json()


def _queue_title(app: str, record: dict) -> str:
    if app == "radarr":
        return record.get("title") or "?"
    ep = record.get("episode") or {}
    series = (record.get("series") or {}).get("title", "?")
    if ep:
        return f"{series} S{ep.get('seasonNumber', 0):02d}E{ep.get('episodeNumber', 0):02d}"
    return record.get("title") or series


async def _app_queue(app: str) -> list[dict]:
    data = await _get(app, "/queue", {"pageSize": 50})
    out = []
    for r in data.get("records", []):
        messages = [
            m
            for sm in r.get("statusMessages", [])
            for m in sm.get("messages", [])
        ]
        out.append({
            "app": app,
            "title": _queue_title(app, r),
            "status": r.get("status"),
            "downloadState": r.get("trackedDownloadState"),
            "downloadStatus": r.get("trackedDownloadStatus"),
            "timeleft": r.get("timeleft"),
            "error": r.get("errorMessage") or (messages[0] if messages else None),
        })
    return out


async def import_queues() -> list[dict]:
    radarr, sonarr = await asyncio.gather(_app_queue("radarr"), _app_queue("sonarr"))
    return radarr + sonarr


async def _put(app: str, path: str, body: dict):
    async with httpx.AsyncClient() as client:
        res = await client.put(
            f"{APPS[app]}{path}",
            headers={"X-Api-Key": _key(app)},
            json=body,
            timeout=15.0,
        )
        res.raise_for_status()
        return res.json()


async def unmonitor_movie(tmdb_id: int) -> dict:
    """Find a movie by tmdbId in Radarr and set monitored=false so Radarr
    stops upgrading it (e.g. when user chose a specific quality/audio)."""
    movies = await _get("radarr", "/movie")
    match = next((m for m in movies if m.get("tmdbId") == tmdb_id), None)
    if not match:
        return {"error": f"Movie with tmdbId {tmdb_id} not found in Radarr"}
    match["monitored"] = False
    await _put("radarr", f"/movie/{match['id']}", match)
    return {"title": match.get("title"), "tmdbId": tmdb_id, "monitored": False}


async def missing(limit: int = 15) -> dict:
    params = {"pageSize": limit, "monitored": "true"}
    radarr, sonarr = await asyncio.gather(
        _get("radarr", "/wanted/missing", params),
        _get("sonarr", "/wanted/missing", params),
    )
    movies = [
        {"title": r.get("title"), "year": r.get("year")}
        for r in radarr.get("records", [])
    ]
    episodes = [
        {
            "series": (r.get("series") or {}).get("title"),
            "episode": f"S{r.get('seasonNumber', 0):02d}E{r.get('episodeNumber', 0):02d}",
            "title": r.get("title"),
            "airDate": (r.get("airDateUtc") or "")[:10],
        }
        for r in sonarr.get("records", [])
    ]
    return {
        "missing_movies": {"total": radarr.get("totalRecords", 0), "items": movies},
        "missing_episodes": {"total": sonarr.get("totalRecords", 0), "items": episodes},
    }
