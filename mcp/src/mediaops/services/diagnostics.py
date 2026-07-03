"""Diagnostics layer: composes process, HTTP, and ARR health into full pictures."""

from __future__ import annotations

import asyncio
import re

import httpx

from ..inventory import SERVICES, Service
from . import health, process

_ERROR_LINE_RE = re.compile(r"error|exception|fatal|fail|warn|traceback", re.IGNORECASE)


async def service_snapshot(client: httpx.AsyncClient, svc: Service) -> dict:
    state, http_result = await asyncio.gather(
        process.process_state(svc),
        health.http_health(client, svc),
    )
    ok = state.running and http_result.ok
    snapshot = {
        "service": svc.id,
        "runtime": svc.runtime.value,
        "ok": ok,
        "process": {"running": state.running, "detail": state.detail, "restarts": state.restarts},
        "http": {"ok": http_result.ok, "reason": http_result.reason},
    }
    return snapshot


async def stack_status() -> list[dict]:
    async with httpx.AsyncClient() as client:
        return list(await asyncio.gather(*(service_snapshot(client, s) for s in SERVICES)))


async def deep_health() -> dict:
    async with httpx.AsyncClient() as client:
        snapshots, resources = await asyncio.gather(
            asyncio.gather(*(service_snapshot(client, s) for s in SERVICES)),
            process.host_resources(),
        )
        arr_results = await asyncio.gather(
            *(health.arr_health(client, s) for s in SERVICES if s.arr_health_path)
        )
    arr_report = {
        svc.id: {"ok": result.ok, "reason": result.reason, "issues": result.issues}
        for svc, result in zip([s for s in SERVICES if s.arr_health_path], arr_results)
    }
    return {"services": list(snapshots), "arr_health": arr_report, "host": resources}


def _error_lines(log_text: str, limit: int = 40) -> list[str]:
    matched = [line for line in log_text.splitlines() if _ERROR_LINE_RE.search(line)]
    return matched[-limit:]


async def explain_service(svc: Service) -> dict:
    async with httpx.AsyncClient() as client:
        snapshot = await service_snapshot(client, svc)
        arr = (
            await health.arr_health(client, svc)
            if svc.arr_health_path
            else None
        )
    try:
        logs = await process.service_logs(svc, 200)
    except process.CommandError as err:
        logs = f"(could not fetch logs: {err})"

    report = {
        **snapshot,
        "recent_error_lines": _error_lines(logs),
        "last_log_lines": logs.splitlines()[-25:],
    }
    if arr is not None:
        report["arr_health"] = {"ok": arr.ok, "reason": arr.reason, "issues": arr.issues}
    return report
