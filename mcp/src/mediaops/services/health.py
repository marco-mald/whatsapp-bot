"""HTTP health layer: shallow endpoint checks and deep ARR health APIs."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import httpx

from ..inventory import Service

_APIKEY_RE = re.compile(r"<ApiKey>([^<]+)</ApiKey>")


@dataclass
class HealthResult:
    ok: bool
    reason: str = "responding"
    issues: list[dict] = field(default_factory=list)


async def http_health(client: httpx.AsyncClient, svc: Service) -> HealthResult:
    try:
        res = await client.get(svc.health_url, timeout=5.0)
        if res.status_code < 500:
            return HealthResult(True)
        return HealthResult(False, f"HTTP {res.status_code}")
    except httpx.ConnectError:
        return HealthResult(False, "connection refused (port closed)")
    except httpx.TimeoutException:
        return HealthResult(False, "timeout")
    except httpx.HTTPError as err:
        return HealthResult(False, str(err))


def _read_api_key(svc: Service) -> str | None:
    if not svc.config_xml or not svc.config_xml.exists():
        return None
    match = _APIKEY_RE.search(svc.config_xml.read_text())
    return match.group(1) if match else None


async def arr_health(client: httpx.AsyncClient, svc: Service) -> HealthResult:
    """Query an ARR app's /health API: returns active warnings/errors
    (full disk, unreachable indexers, import failures, etc.)."""
    if not svc.arr_health_path:
        return HealthResult(True, "no deep health API")

    api_key = _read_api_key(svc)
    if not api_key:
        return HealthResult(False, f"could not read ApiKey from {svc.config_xml}")

    try:
        res = await client.get(
            svc.arr_health_path, headers={"X-Api-Key": api_key}, timeout=8.0
        )
        res.raise_for_status()
    except httpx.HTTPError as err:
        return HealthResult(False, f"health API failed: {err}")

    issues = [
        {"type": item.get("type"), "source": item.get("source"), "message": item.get("message")}
        for item in res.json()
    ]
    if issues:
        return HealthResult(False, f"{len(issues)} active issue(s)", issues)
    return HealthResult(True, "no active issues")
