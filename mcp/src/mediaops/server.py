"""MediaOps MCP server: high-level tools over the media stack.

Claude never talks to Radarr/Sonarr/docker/pm2 directly — only through these
tools. Tool names use underscores (MCP-safe form of the module.action style):
system_status ~ system.status, diagnostics_explain ~ diagnostics.explain.
"""

from __future__ import annotations

import asyncio
import json

from mcp.server.fastmcp import FastMCP

from .inventory import SERVICE_IDS, find_service
from .services import diagnostics, process

mcp = FastMCP("mediaops")

_UNKNOWN = "Unknown service {!r}. Valid services: " + ", ".join(SERVICE_IDS)


def _dumps(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=1)


@mcp.tool()
async def system_status() -> str:
    """Quick status of every service in the media stack: process state
    (docker/systemd/pm2) plus HTTP health endpoint. Use this first for any
    'how is the server' question."""
    return _dumps(await diagnostics.stack_status())


@mcp.tool()
async def system_logs(service: str, lines: int = 50) -> str:
    """Recent log lines for one service (max 200). Valid services:
    radarr, sonarr, prowlarr, bazarr, jellyseerr, qbittorrent, jellyfin,
    media-manager."""
    svc = find_service(service)
    if not svc:
        return _UNKNOWN.format(service)
    try:
        return await process.service_logs(svc, lines)
    except process.CommandError as err:
        return f"Failed to fetch logs for {svc.id}: {err}"


@mcp.tool()
async def system_restart(service: str) -> str:
    """Restart one service (docker restart / pm2 restart / systemctl restart),
    then re-check that it came back up. Only use when the user asked for a
    restart or clearly approved one."""
    svc = find_service(service)
    if not svc:
        return _UNKNOWN.format(service)
    try:
        await process.restart_service(svc)
    except process.CommandError as err:
        return _dumps({"service": svc.id, "restarted": False, "error": str(err)})

    await asyncio.sleep(5)
    report = await diagnostics.explain_service(svc)
    return _dumps({"service": svc.id, "restarted": True, "post_restart": report})


@mcp.tool()
async def system_resources() -> str:
    """Host resources: disk usage per mount, memory, and load average.
    Use for 'what is taking so much space' or performance questions."""
    return _dumps(await process.host_resources())


@mcp.tool()
async def diagnostics_health() -> str:
    """Deep health report: every service's process+HTTP state, the ARR apps'
    own health APIs (active warnings like full disk or failing indexers), and
    host resources. Slower than system_status but far more informative."""
    return _dumps(await diagnostics.deep_health())


@mcp.tool()
async def diagnostics_explain(service: str) -> str:
    """Everything known about one service in a single call: process state,
    restart count, HTTP health, ARR health issues, recent error lines from
    logs, and the last log lines. Use to answer 'why is X failing'."""
    svc = find_service(service)
    if not svc:
        return _UNKNOWN.format(service)
    return _dumps(await diagnostics.explain_service(svc))


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
