"""qBittorrent layer: download queue visibility and pause/resume control."""

from __future__ import annotations

import httpx

from ..config import env


async def _client() -> httpx.AsyncClient:
    cfg = env()
    client = httpx.AsyncClient(base_url=cfg["QBIT_URL"], timeout=15.0)
    res = await client.post(
        "/api/v2/auth/login",
        data={"username": cfg["QBIT_USER"], "password": cfg["QBIT_PASS"]},
    )
    # success is 200 or 204 with a session cookie (SID= or QBT_SID_<port>=)
    if res.status_code >= 300 or "SID" not in res.headers.get("set-cookie", ""):
        await client.aclose()
        raise RuntimeError(f"qBittorrent login failed (HTTP {res.status_code})")
    return client


def _fmt_eta(secs: int) -> str:
    if not secs or secs <= 0 or secs >= 8_640_000:
        return "∞"
    h, m = divmod(secs // 60, 60)
    return f"{h}h {m}m" if h else f"{m}m"


async def torrents() -> list[dict]:
    client = await _client()
    try:
        res = await client.get("/api/v2/torrents/info")
        res.raise_for_status()
    finally:
        await client.aclose()
    return [
        {
            "hash": t["hash"],
            "name": t["name"],
            "state": t["state"],
            "progress": round(t["progress"] * 100, 1),
            "dlspeed_kbps": t["dlspeed"] // 1024,
            "eta": _fmt_eta(t.get("eta", 0)),
            "size_gb": round(t["size"] / 1024**3, 2),
        }
        for t in res.json()
    ]


async def control(action: str, torrent_hash: str = "all") -> str:
    if action not in ("pause", "resume"):
        raise ValueError("action must be 'pause' or 'resume'")

    # qBittorrent v5 renamed pause/resume to stop/start; try modern name on 404
    endpoints = {"pause": ("pause", "stop"), "resume": ("resume", "start")}
    client = await _client()
    try:
        for name in endpoints[action]:
            res = await client.post(f"/api/v2/torrents/{name}", data={"hashes": torrent_hash})
            if res.status_code == 200:
                return f"{action} ok ({torrent_hash})"
        raise RuntimeError(f"{action} failed: HTTP {res.status_code}")
    finally:
        await client.aclose()
