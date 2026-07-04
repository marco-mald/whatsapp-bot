"""Analytics layer: Jellyfin sessions, storage breakdown, library summary."""

from __future__ import annotations

import asyncio

import httpx

from ..config import env
from .process import _run


async def jellyfin_sessions() -> list[dict]:
    cfg = env()
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{cfg.get('JELLYFIN_URL', 'http://localhost:8096')}/Sessions",
            params={"api_key": cfg["JELLYFIN_API_KEY"]},
            timeout=10.0,
        )
        res.raise_for_status()
    out = []
    for s in res.json():
        item = s.get("NowPlayingItem")
        out.append({
            "user": s.get("UserName"),
            "device": s.get("DeviceName"),
            "playing": item.get("Name") if item else None,
            "method": (s.get("PlayState") or {}).get("PlayMethod") if item else None,
        })
    return out


async def storage() -> dict:
    df, du = await asyncio.gather(
        _run("df", "-h", "--output=target,size,used,avail,pcent", "/mnt/ADATA", "/"),
        _run("du", "-BG", "--max-depth=1", "/mnt/ADATA", timeout=120.0),
    )
    folders = []
    for line in du.splitlines():
        size, _, folder = line.partition("\t")
        folders.append({"folder": folder.strip(), "size": size.strip()})
    folders.sort(key=lambda f: -int(f["size"].rstrip("G") or 0))
    return {"filesystems": df, "media_folders": folders}


async def library_summary() -> dict:
    from ..inventory import ARRSTACK  # noqa: F401  (documents the data source)
    from .arr_media import _get

    radarr_movies, sonarr_series = await asyncio.gather(
        _get("radarr", "/movie"),
        _get("sonarr", "/series"),
    )
    movies_with_file = sum(1 for m in radarr_movies if m.get("hasFile"))
    total_eps = sum((s.get("statistics") or {}).get("episodeCount", 0) for s in sonarr_series)
    have_eps = sum((s.get("statistics") or {}).get("episodeFileCount", 0) for s in sonarr_series)
    size_gb = round(
        (sum(m.get("sizeOnDisk", 0) for m in radarr_movies)
         + sum((s.get("statistics") or {}).get("sizeOnDisk", 0) for s in sonarr_series)) / 1024**3,
        1,
    )
    return {
        "movies": {"total": len(radarr_movies), "downloaded": movies_with_file},
        "series": {"total": len(sonarr_series), "episodes": total_eps, "episodes_downloaded": have_eps},
        "library_size_gb": size_gb,
    }


def _poster_from_images(images: list) -> str | None:
    for img in (images or []):
        if img.get("coverType") == "poster":
            url = img.get("remoteUrl") or img.get("url", "")
            if url.startswith("http"):
                return url
    return None


async def library_catalog() -> dict:
    """List all movies and series currently available in the library."""
    from .arr_media import _get

    radarr_movies, sonarr_series = await asyncio.gather(
        _get("radarr", "/movie"),
        _get("sonarr", "/series"),
    )
    movies = [
        {
            "title": m.get("title"),
            "year": m.get("year"),
            "tmdbId": m.get("tmdbId"),
            "posterUrl": _poster_from_images(m.get("images")),
        }
        for m in radarr_movies
        if m.get("hasFile")
    ]
    movies.sort(key=lambda m: m.get("title", "").lower())

    series = [
        {
            "title": s.get("title"),
            "year": s.get("year"),
            "tvdbId": s.get("tvdbId"),
            "posterUrl": _poster_from_images(s.get("images")),
        }
        for s in sonarr_series
        if (s.get("statistics") or {}).get("episodeFileCount", 0) > 0
    ]
    series.sort(key=lambda s: s.get("title", "").lower())

    return {"movies": movies, "series": series}
