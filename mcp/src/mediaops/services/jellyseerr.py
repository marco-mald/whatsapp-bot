"""Jellyseerr layer: content search, requests, and request management."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from ..config import env

MEDIA_STATUS = {
    1: "not_requested",
    2: "pending_approval",
    3: "downloading",
    4: "partially_available",
    5: "available",
}


def _base() -> tuple[str, dict[str, str]]:
    cfg = env()
    return cfg["JELLYSEERR_URL"], {"X-Api-Key": cfg["JELLYSEERR_API_KEY"]}


async def _get(path: str, params: dict | None = None) -> Any:
    base, headers = _base()
    async with httpx.AsyncClient() as client:
        res = await client.get(f"{base}{path}", headers=headers, params=params, timeout=15.0)
        res.raise_for_status()
        return res.json()


async def _post(path: str, body: dict | None = None) -> Any:
    base, headers = _base()
    async with httpx.AsyncClient() as client:
        res = await client.post(f"{base}{path}", headers=headers, json=body, timeout=20.0)
        res.raise_for_status()
        return res.json() if res.content else None


def _year(item: dict) -> str:
    date = item.get("releaseDate") or item.get("firstAirDate") or ""
    return date[:4] or "?"


def _poster_url(item: dict) -> str | None:
    path = item.get("posterPath")
    return f"https://image.tmdb.org/t/p/w500{path}" if path else None


async def trending(limit: int = 6) -> list[dict]:
    data = await _get("/api/v1/discover/trending", {"page": 1})
    out = []
    for item in data.get("results", [])[:limit]:
        if item.get("mediaType") not in ("movie", "tv"):
            continue
        status_code = (item.get("mediaInfo") or {}).get("status", 1)
        out.append({
            "mediaType": item["mediaType"],
            "tmdbId": item["id"],
            "title": item.get("title") or item.get("name"),
            "year": _year(item),
            "status": MEDIA_STATUS.get(status_code, "unknown"),
            "overview": (item.get("overview") or "")[:180],
            "posterUrl": _poster_url(item),
        })
    return out


async def search(query: str, limit: int = 8) -> list[dict]:
    # Jellyseerr rejects '+' for spaces in this endpoint; it requires %20
    data = await _get(f"/api/v1/search?query={quote(query)}")
    results = []
    for item in data.get("results", []):
        if item.get("mediaType") not in ("movie", "tv"):
            continue
        status_code = (item.get("mediaInfo") or {}).get("status", 1)
        overview = (item.get("overview") or "")[:180]
        results.append({
            "mediaType": item["mediaType"],
            "tmdbId": item["id"],
            "title": item.get("title") or item.get("name"),
            "year": _year(item),
            "status": MEDIA_STATUS.get(status_code, "unknown"),
            "overview": overview,
            "posterUrl": _poster_url(item),
        })
        if len(results) >= limit:
            break
    return results


async def request_media(media_type: str, tmdb_id: int, jellyseerr_user_id: int | None = None, seasons: list[int] | None = None) -> dict:
    body: dict[str, Any] = {"mediaType": media_type, "mediaId": tmdb_id}
    if media_type == "tv":
        if seasons:
            body["seasons"] = seasons
        else:
            body["seasons"] = [1]
    if jellyseerr_user_id:
        body["userId"] = jellyseerr_user_id

    created = await _post("/api/v1/request", body)
    return {
        "requestId": created.get("id"),
        "status": created.get("status"),
        "media_status": MEDIA_STATUS.get((created.get("media") or {}).get("status", 1), "unknown"),
    }


async def user_requests(jellyseerr_user_id: int, take: int = 20) -> list[dict]:
    """Get all requests made by a specific user."""
    data = await _get("/api/v1/request", {"take": take, "sort": "added", "requestedBy": jellyseerr_user_id})
    out = []
    for req in data.get("results", []):
        media = req.get("media") or {}
        status = MEDIA_STATUS.get(media.get("status", 1), "unknown")
        out.append({
            "title": (req.get("media") or {}).get("title") or req.get("subject") or "?",
            "mediaType": media.get("mediaType"),
            "status": status,
            "createdAt": (req.get("createdAt") or "")[:10],
        })
    return out


async def user_request_tmdb_ids(jellyseerr_user_id: int, take: int = 50) -> set[int]:
    """tmdbIds of everything this user has requested — the ownership ground
    truth for restricted torrent deletion."""
    data = await _get("/api/v1/request", {"take": take, "sort": "added", "requestedBy": jellyseerr_user_id})
    return {
        (req.get("media") or {}).get("tmdbId")
        for req in data.get("results", [])
        if (req.get("media") or {}).get("tmdbId")
    }


async def requester_by_tmdb(tmdb_id: int) -> dict | None:
    """Return the Jellyseerr requester for a given tmdbId, or None if not found.
    Result: {jellyseerrId, username} of the user who requested it."""
    data = await _get("/api/v1/request", {"take": 5, "sort": "added", "mediaId": tmdb_id})
    req = next(iter(data.get("results", [])), None)
    if not req:
        return None
    requested_by = req.get("requestedBy") or {}
    uid = requested_by.get("id")
    username = requested_by.get("username") or requested_by.get("displayName")
    if not uid:
        return None
    return {"jellyseerrId": uid, "username": username}


