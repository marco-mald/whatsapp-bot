"""Media Manager layer: audio-normalization state of the library and jobs.

Talks to the custom pm2 app on :5000 (Flask, see ~/Downloads/media_manager).
Statuses come from its classifier: 'ok', 'needs-fix' (wrong default/extras),
'no-aac' (no AAC track yet).
"""

from __future__ import annotations

import asyncio
from collections import Counter

import httpx

BASE = "http://localhost:5000/api"
SCAN_POLL_SECONDS = 3
SCAN_MAX_WAIT_SECONDS = 120


async def _get(client: httpx.AsyncClient, path: str):
    res = await client.get(f"{BASE}{path}", timeout=20.0)
    res.raise_for_status()
    return res.json()


async def report(rescan: bool = False) -> dict:
    async with httpx.AsyncClient() as client:
        status = await _get(client, "/scan_status")

        if rescan or not status.get("done"):
            await client.post(f"{BASE}/scan", timeout=20.0)
            waited = 0
            while waited < SCAN_MAX_WAIT_SECONDS:
                await asyncio.sleep(SCAN_POLL_SECONDS)
                waited += SCAN_POLL_SECONDS
                status = await _get(client, "/scan_status")
                if status.get("done"):
                    break
            else:
                return {"scanning": True, "note": f"scan still running after {SCAN_MAX_WAIT_SECONDS}s, retry later"}

    files = status.get("files", [])
    by_status = Counter(f.get("status", "unknown") for f in files)
    pending = [
        {"file_id": f["id"], "file": f["filepath"].rsplit("/", 1)[-1], "status": f.get("status")}
        for f in files
        if f.get("status") in ("needs-fix", "no-aac")
    ]
    return {"total_files": len(files), "by_status": dict(by_status), "pending_normalization": pending}


async def normalize(file_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        res = await client.post(f"{BASE}/normalize", json={"file_id": file_id}, timeout=20.0)
        res.raise_for_status()
        return res.json()


async def job_status(job_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        data = await _get(client, f"/job/{job_id}")
    return {"done": data.get("done"), "log_tail": data.get("log", [])[-12:]}
