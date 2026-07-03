"""Media Manager layer: normalization state, jobs, and concurrency guardrails.

Talks to the custom pm2 Flask app on :5000 (see ~/Downloads/media_manager,
README has the full API). Statuses: ok | needs-fix (default track) | no-aac
(audio) | needs-video (H.264 re-encode, 30-90 min) | 4k (skipped) | error.

Media Manager has NO job queue — every /api/normalize spawns a parallel
ffmpeg. The MAX_ACTIVE_JOBS guard here enforces sequential processing so a
batch request can never melt the host or kill Jellyfin streaming.
"""

from __future__ import annotations

import asyncio
from collections import Counter

import httpx

BASE = "http://localhost:5000/api"
SCAN_POLL_SECONDS = 3
SCAN_MAX_WAIT_SECONDS = 120
MAX_ACTIVE_JOBS = 1

PENDING_STATUSES = ("needs-fix", "no-aac", "needs-video")


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

        sysinfo = await _get(client, "/sysinfo")

    files = status.get("files", [])
    by_status = Counter(f.get("status", "unknown") for f in files)
    pending = [
        {"file_id": f["id"], "file": f["name"], "status": f.get("status")}
        for f in files
        if f.get("status") in PENDING_STATUSES
    ]
    errors = [f["name"] for f in files if f.get("status") == "error"]
    return {
        "total_files": len(files),
        "by_status": dict(by_status),
        "active_jobs": sysinfo.get("active_jobs", 0),
        "cpu_percent": sysinfo.get("cpu"),
        "pending_normalization": pending,
        "files_with_errors": errors,
    }


async def normalize(file_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        sysinfo = await _get(client, "/sysinfo")
        active = sysinfo.get("active_jobs", 0)
        if active >= MAX_ACTIVE_JOBS:
            return {
                "started": False,
                "reason": f"{active} job(s) already running — normalization is strictly "
                          "sequential to protect streaming. Wait for the current job "
                          "(optimization_job) or cancel it (optimization_cancel).",
            }
        res = await client.post(f"{BASE}/normalize", json={"file_id": file_id}, timeout=20.0)
        res.raise_for_status()
        data = res.json()
    if "error" in data:
        return {"started": False, "reason": data["error"]}
    return {"started": True, "job_id": data["job_id"]}


async def job_status(job_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        data = await _get(client, f"/job/{job_id}")
    log = data.get("log", [])
    # Derive % progress from ffmpeg 'time=HH:MM:SS' lines vs total_duration
    progress = None
    total = data.get("total_duration") or 0
    for line in reversed(log):
        if "time=" in line:
            try:
                hh, mm, ss = line.split("time=")[1].split(" ")[0].split(":")
                progress = round((int(hh) * 3600 + int(mm) * 60 + float(ss)) / total * 100, 1) if total else None
            except (ValueError, IndexError):
                pass
            break
    return {"done": data.get("done"), "progress_percent": progress, "log_tail": log[-10:]}


async def cancel(job_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        res = await client.post(f"{BASE}/cancel/{job_id}", timeout=20.0)
        res.raise_for_status()
        return res.json()
