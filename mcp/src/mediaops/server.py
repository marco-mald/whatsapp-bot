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
from .services import (
    analytics,
    arr_media,
    bazarr,
    diagnostics,
    jellyseerr,
    mediamanager,
    memory,
    process,
    prowlarr,
    qbittorrent,
)

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


@mcp.tool()
async def library_search(query: str) -> str:
    """Search movies/series by name. Returns each result's tmdbId and current
    library status: available, downloading, pending_approval,
    partially_available, or not_requested. Always use this first to answer
    'do we have X?' or before adding anything."""
    try:
        return _dumps(await jellyseerr.search(query))
    except Exception as err:
        return f"library_search failed: {err}"


@mcp.tool()
async def media_add(media_type: str, tmdb_id: int, jellyseerr_user_id: int | None = None) -> str:
    """Request a movie or series ('movie' or 'tv', tmdbId from library_search).
    The request is auto-approved and downloading starts immediately, so confirm
    intent before calling. For tv, all seasons are requested. Optionally
    attribute the request to a Jellyseerr user id."""
    if media_type not in ("movie", "tv"):
        return "media_type must be 'movie' or 'tv'"
    try:
        return _dumps(await jellyseerr.request_media(media_type, tmdb_id, jellyseerr_user_id))
    except Exception as err:
        return f"media_add failed: {err}"


@mcp.tool()
async def requests_pending() -> str:
    """List Jellyseerr requests waiting for approval (requestId, media,
    who asked, when)."""
    try:
        return _dumps(await jellyseerr.pending_requests())
    except Exception as err:
        return f"requests_pending failed: {err}"


@mcp.tool()
async def requests_manage(request_id: int, action: str) -> str:
    """Approve or decline a pending Jellyseerr request.
    action: 'approve' | 'decline'."""
    try:
        return await jellyseerr.manage_request(request_id, action)
    except Exception as err:
        return f"requests_manage failed: {err}"


@mcp.tool()
async def downloads_status() -> str:
    """Current qBittorrent torrents: state, progress %, speed, ETA, size.
    Use for 'how are the downloads going'."""
    try:
        return _dumps(await qbittorrent.torrents())
    except Exception as err:
        return f"downloads_status failed: {err}"


@mcp.tool()
async def downloads_control(action: str, torrent_hash: str = "all") -> str:
    """Pause or resume torrents. action: 'pause' | 'resume';
    torrent_hash: a hash from downloads_status, or 'all'."""
    try:
        return await qbittorrent.control(action, torrent_hash)
    except Exception as err:
        return f"downloads_control failed: {err}"


@mcp.tool()
async def media_queue() -> str:
    """Radarr+Sonarr import queues: what is downloading/importing right now
    and, crucially, per-item errors (stuck imports, failed downloads). The
    first place to look for 'why didn't X arrive'."""
    try:
        return _dumps(await arr_media.import_queues())
    except Exception as err:
        return f"media_queue failed: {err}"


@mcp.tool()
async def library_missing(limit: int = 15) -> str:
    """Monitored but missing media: movies (Radarr) and aired episodes
    (Sonarr) that haven't been downloaded yet."""
    try:
        return _dumps(await arr_media.missing(limit))
    except Exception as err:
        return f"library_missing failed: {err}"


@mcp.tool()
async def subtitles_missing(limit: int = 20) -> str:
    """Movies and episodes with missing subtitles (Bazarr), including which
    languages are missing and the ids needed for subtitles_search."""
    try:
        return _dumps(await bazarr.wanted(limit))
    except Exception as err:
        return f"subtitles_missing failed: {err}"


@mcp.tool()
async def subtitles_search(media_type: str, item_id: int) -> str:
    """Trigger a subtitle search for one item. media_type: 'movie' (item_id =
    radarrId from subtitles_missing) or 'episode' (item_id = sonarrEpisodeId).
    Bazarr downloads the best subtitle automatically if found."""
    try:
        if media_type == "movie":
            return await bazarr.search_movie(item_id)
        if media_type == "episode":
            return await bazarr.search_episode(item_id)
        return "media_type must be 'movie' or 'episode'"
    except Exception as err:
        return f"subtitles_search failed: {err}"


@mcp.tool()
async def indexers_health() -> str:
    """All Prowlarr indexers with their state: enabled, temporarily disabled
    due to failures (disabledTill), and the most recent failure reason."""
    try:
        return _dumps(await prowlarr.indexers())
    except Exception as err:
        return f"indexers_health failed: {err}"


@mcp.tool()
async def indexers_test() -> str:
    """Run a live connectivity test against every Prowlarr indexer (takes up
    to a minute). Returns pass/fail with error details per indexer."""
    try:
        return _dumps(await prowlarr.test_all())
    except Exception as err:
        return f"indexers_test failed: {err}"


@mcp.tool()
async def optimization_report(rescan: bool = False) -> str:
    """Normalization state of the library (Media Manager): counts by status,
    files pending normalization (needs-fix = default track, no-aac = audio,
    needs-video = full H.264 re-encode taking 30-90 min), files with errors,
    plus current CPU and active job count. rescan=True re-analyzes every file
    (slow); otherwise uses the last scan."""
    try:
        return _dumps(await mediamanager.report(rescan))
    except Exception as err:
        return f"optimization_report failed: {err}"


@mcp.tool()
async def optimization_run(file_id: str) -> str:
    """Start normalizing ONE file via Media Manager (H.264 re-encode if
    needed + AAC 2.0 audio). Strictly sequential: refuses if another job is
    already running — never try to start several at once. needs-video jobs
    take 30-90 min: start it, tell the user it's running, and let them ask
    later; do NOT wait for completion. Returns a job_id for optimization_job."""
    try:
        return _dumps(await mediamanager.normalize(file_id))
    except Exception as err:
        return f"optimization_run failed: {err}"


@mcp.tool()
async def optimization_job(job_id: str) -> str:
    """Progress of a normalization job: done flag, % progress derived from
    ffmpeg output, and log tail (OK:/ERROR: lines indicate the outcome)."""
    try:
        return _dumps(await mediamanager.job_status(job_id))
    except Exception as err:
        return f"optimization_job failed: {err}"


@mcp.tool()
async def optimization_cancel(job_id: str) -> str:
    """Cancel a running normalization job (SIGTERM to ffmpeg; temp files are
    cleaned up automatically). Only when the user asks or a job is stuck."""
    try:
        return _dumps(await mediamanager.cancel(job_id))
    except Exception as err:
        return f"optimization_cancel failed: {err}"


@mcp.tool()
async def streaming_sessions() -> str:
    """Who is watching Jellyfin right now: user, device, title, and whether
    it's direct play or transcoding. Also check before heavy operations."""
    try:
        return _dumps(await analytics.jellyfin_sessions())
    except Exception as err:
        return f"streaming_sessions failed: {err}"


@mcp.tool()
async def analytics_storage() -> str:
    """Disk usage: filesystems (including the media mount /mnt/ADATA) and
    size per media folder. Use for 'what is taking so much space'."""
    try:
        return _dumps(await analytics.storage())
    except Exception as err:
        return f"analytics_storage failed: {err}"


@mcp.tool()
async def analytics_library() -> str:
    """Library totals: movies (owned/downloaded), series with episode
    completeness, and total library size on disk."""
    try:
        return _dumps(await analytics.library_summary())
    except Exception as err:
        return f"analytics_library failed: {err}"


@mcp.tool()
async def memory_recall() -> str:
    """Saved preferences and standing decisions (e.g. 'Latino audio preferred',
    'nothing over 8GB'). Check this before media or quality decisions."""
    try:
        return _dumps(memory.recall())
    except Exception as err:
        return f"memory_recall failed: {err}"


@mcp.tool()
async def memory_save(note: str) -> str:
    """Persist a preference or standing decision for future sessions. Save
    only durable facts ('prefers X'), not one-off events."""
    try:
        return memory.save(note)
    except Exception as err:
        return f"memory_save failed: {err}"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
