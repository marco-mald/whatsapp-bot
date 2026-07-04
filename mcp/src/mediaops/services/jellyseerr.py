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


async def pending_requests(take: int = 20) -> list[dict]:
    data = await _get("/api/v1/request", {"filter": "pending", "take": take, "sort": "added"})
    out = []
    for req in data.get("results", []):
        media = req.get("media") or {}
        out.append({
            "requestId": req.get("id"),
            "mediaType": media.get("mediaType"),
            "tmdbId": media.get("tmdbId"),
            "requestedBy": (req.get("requestedBy") or {}).get("displayName"),
            "createdAt": req.get("createdAt"),
        })
    return out


async def manage_request(request_id: int, action: str) -> str:
    if action not in ("approve", "decline"):
        raise ValueError("action must be 'approve' or 'decline'")
    await _post(f"/api/v1/request/{request_id}/{action}")
    return f"request {request_id} {action}d"
