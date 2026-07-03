"""Prowlarr layer: indexer inventory, failure status, and connectivity tests."""

from __future__ import annotations

import asyncio
import re

import httpx

from ..inventory import ARRSTACK

BASE = "http://localhost:9696/api/v1"
_APIKEY_RE = re.compile(r"<ApiKey>([^<]+)</ApiKey>")


def _key() -> str:
    xml = (ARRSTACK / "prowlarr" / "config.xml").read_text()
    return _APIKEY_RE.search(xml).group(1)


async def _get(path: str):
    async with httpx.AsyncClient() as client:
        res = await client.get(f"{BASE}{path}", headers={"X-Api-Key": _key()}, timeout=20.0)
        res.raise_for_status()
        return res.json()


async def indexers() -> list[dict]:
    inds, statuses = await asyncio.gather(_get("/indexer"), _get("/indexerstatus"))
    failures = {s["indexerId"]: s for s in statuses}
    out = []
    for ind in inds:
        fail = failures.get(ind["id"])
        out.append({
            "id": ind["id"],
            "name": ind["name"],
            "enabled": ind["enable"],
            "disabledTill": fail.get("disabledTill") if fail else None,
            "recentFailure": (fail.get("mostRecentFailure") if fail else None),
        })
    return out


async def test_all() -> list[dict]:
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{BASE}/indexer/testall", headers={"X-Api-Key": _key()}, timeout=120.0
        )
        # 200 = all passed; 400 returns per-indexer validation failures
        if res.status_code not in (200, 400):
            res.raise_for_status()
        results = res.json() if res.content else []

    inds = {i["id"]: i["name"] for i in await _get("/indexer")}
    return [
        {
            "indexer": inds.get(r.get("id"), r.get("id")),
            "ok": r.get("isValid", False),
            "errors": [f.get("errorMessage") for f in r.get("validationFailures", [])][:2],
        }
        for r in results
    ]
