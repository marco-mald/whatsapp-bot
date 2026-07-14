"""MediaOps MCP server: high-level tools over the media stack.

Claude never talks to Radarr/Sonarr/docker/pm2 directly — only through these
tools. Tool names use underscores (MCP-safe form of the module.action style):
system_status ~ system.status, diagnostics_explain ~ diagnostics.explain.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from functools import wraps

from mcp.server.fastmcp import FastMCP


# Simple TTL cache for read-only tool results
_cache: dict[str, tuple[float, str]] = {}
CACHE_TTL = 30  # seconds


def cached(ttl: int = CACHE_TTL):
    """Cache async function results by args for `ttl` seconds."""
    def decorator(fn):
        @wraps(fn)
        async def wrapper(*args, **kwargs):
            key = f"{fn.__name__}:{args}:{kwargs}"
            now = time.time()
            if key in _cache and now - _cache[key][0] < ttl:
                return _cache[key][1]
            result = await fn(*args, **kwargs)
            _cache[key] = (now, result)
            return result
        return wrapper
    return decorator

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

# Every tool call is appended to data/tool-calls.jsonl (ts, tool, args, ok,
# duration, result head) so silent API breakage — like Bazarr's 'search' →
# 'search-missing' rename — shows up in one grep instead of being invisible.
# Rotated at ~2MB (single .1 backup), never unbounded.
from pathlib import Path

TOOL_LOG = Path(__file__).resolve().parents[3] / "data" / "tool-calls.jsonl"
STALLED_STATE_PATH = Path(__file__).resolve().parents[3] / "data" / "stalled-state.json"

# fix_stalled_downloads requires a torrent to be seen stalled across multiple
# consecutive 20-min runs before acting — a single stalledDL/error reading is
# a point-in-time qBittorrent state that can flicker for seconds (a peer
# reconnect blip), not evidence of a real problem. Torrents close to done get
# a longer confirmation window: losing 90%+ progress to a false positive is
# far more costly than losing 10%, and near-complete torrents are more likely
# to self-recover anyway (final piece hash-check, tracker re-announce, etc).
STALL_CONFIRM_SECONDS = 20 * 60       # ~1 extra run for progress < HIGH_PROGRESS
STALL_CONFIRM_SECONDS_HIGH = 90 * 60  # ~4 extra runs for progress >= HIGH_PROGRESS
HIGH_PROGRESS = 90.0


def _load_stalled_state() -> dict:
    try:
        return json.loads(STALLED_STATE_PATH.read_text())
    except Exception:
        return {}


def _save_stalled_state(state: dict) -> None:
    STALLED_STATE_PATH.parent.mkdir(exist_ok=True)
    STALLED_STATE_PATH.write_text(json.dumps(state, indent=1))


def _log_call(tool: str, kwargs: dict, result, secs: float) -> None:
    try:
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        # 80 chars was too tight to audit multi-item tool results after the
        # fact — e.g. fix_stalled_downloads' per-torrent progress_was/
        # state_was got silently cut, making "how close was it when deleted"
        # unanswerable from this log alone (found 2026-07-09). 600 covers a
        # handful of items while still bounding log growth.
        head = text[:600]
        ok = not (
            "failed:" in head
            or head.startswith("EXCEPTION")
            or '"error"' in head
        )
        entry: dict = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "tool": tool,
            "args": json.dumps(kwargs, ensure_ascii=False, default=str)[:150],
            "ok": ok,
            "secs": round(secs, 2),
            "result": head,
        }
        run_id = os.environ.get("MEDIAOPS_RUN_ID")
        if run_id:
            entry["run"] = run_id
        line = json.dumps(entry, ensure_ascii=False)
        TOOL_LOG.parent.mkdir(exist_ok=True)
        if TOOL_LOG.exists() and TOOL_LOG.stat().st_size > 2_000_000:
            TOOL_LOG.rename(TOOL_LOG.with_suffix(".jsonl.1"))
        with open(TOOL_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass  # logging must never break a tool


_unlogged_tool = mcp.tool


def _logging_tool(*targs, **tkwargs):
    real = _unlogged_tool(*targs, **tkwargs)

    def decorator(fn):
        @wraps(fn)
        async def wrapper(*a, **kw):
            t0 = time.time()
            try:
                out = await fn(*a, **kw)
                _log_call(fn.__name__, kw, out, time.time() - t0)
                return out
            except Exception as err:
                _log_call(fn.__name__, kw, f"EXCEPTION: {err}", time.time() - t0)
                raise

        return real(wrapper)

    return decorator


mcp.tool = _logging_tool

# MEDIAOPS_PROFILE=restricted registers only the family-facing tools, so those
# runs don't pay context tokens for schemas they can't call anyway (the full
# set is ~2x the size). Keep in sync with RESTRICTED_TOOLS in
# src/services/claudeApi.js.
RESTRICTED_PROFILE_TOOLS = {
    "library_search",
    "library_trending",
    "library_catalog",
    "media_add",
    "media_file_info",
    "my_requests",
    "downloads_status",
    "downloads_delete",
    "downloads_control",
    "media_search_release",
    "media_queue",
    "library_missing",
    "system_status",
    "analytics_storage",
    "analytics_library",
    "subtitles_missing",
    "subtitles_search",
    "recently_added",
    "seasons_info",
    "fix_stalled_downloads",
    "library_by_audio_language",
}

if os.environ.get("MEDIAOPS_PROFILE") == "restricted":
    _full_tool = mcp.tool

    def _profile_tool(*args, **kwargs):
        real = _full_tool(*args, **kwargs)

        def decorator(fn):
            if fn.__name__ not in RESTRICTED_PROFILE_TOOLS:
                return fn  # skip registration entirely
            return real(fn)

        return decorator

    mcp.tool = _profile_tool

_UNKNOWN = "Unknown service {!r}. Valid services: " + ", ".join(SERVICE_IDS)


def _dumps(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=1)


@mcp.tool()
@cached(30)
async def system_status() -> str:
    """Quick status of every service in the stack (radarr, sonarr, prowlarr,
    bazarr, jellyseerr, qbittorrent, jellyfin, media-manager): process state +
    HTTP health per service. Use FIRST for any 'how is the server / is X up'
    question. Read-only. Does NOT cover disk space (analytics_storage) nor
    download progress (downloads_status)."""
    return _dumps(await diagnostics.stack_status())


@mcp.tool()
async def system_logs(service: str, lines: int = 50) -> str:
    """Recent log lines for ONE service (default 50, max 200). service must be
    exactly one of: radarr, sonarr, prowlarr, bazarr, jellyseerr, qbittorrent,
    jellyfin, media-manager. Read-only. For a full 'why is X failing' diagnosis
    prefer diagnostics_explain (it already includes log excerpts)."""
    svc = find_service(service)
    if not svc:
        return _UNKNOWN.format(service)
    try:
        return await process.service_logs(svc, lines)
    except process.CommandError as err:
        return f"Failed to fetch logs for {svc.id}: {err}"


@mcp.tool()
async def system_restart(service: str) -> str:
    """Restart ONE service, wait 5s, and return a post_restart health report.
    Interrupts anything the service was doing — only call when the user
    explicitly asked for or approved a restart; if playback could be affected,
    check streaming_sessions first. Same service ids as system_logs. If
    restarted=false, report the error — do not claim it was restarted."""
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
    """Host resources: disk usage per mount, memory, load average. For 'is the
    server slow / out of RAM' questions. For per-media-folder disk breakdown
    (películas vs series) use analytics_storage instead."""
    return _dumps(await process.host_resources())


@mcp.tool()
async def diagnostics_health() -> str:
    """Deep health report: every service's process+HTTP state, the ARR apps'
    own health APIs (active warnings like full disk or failing indexers), and
    host resources. Slower than system_status but far more informative."""
    return _dumps(await diagnostics.deep_health())


@mcp.tool()
async def diagnostics_explain(service: str) -> str:
    """Everything known about ONE service in a single call: process state,
    restart count, HTTP health, ARR health issues, recent error lines, last
    log lines. THE tool for 'why is X failing'. Same service ids as
    system_logs. Base conclusions only on what it returns."""
    svc = find_service(service)
    if not svc:
        return _UNKNOWN.format(service)
    return _dumps(await diagnostics.explain_service(svc))


@mcp.tool()
async def library_trending(limit: int = 6) -> str:
    """Trending/popular movies and series (Jellyseerr discover). Each item:
    mediaType, tmdbId, title, year, status, overview, posterUrl. Use when
    asked for recommendations / 'qué hay bueno' without a title: pick 1-3,
    show with posters, offer to add. Only recommend titles present in this
    result — never invent titles or posterUrls."""
    try:
        return _dumps(await jellyseerr.trending(limit))
    except Exception as err:
        return f"library_trending failed: {err}"


@mcp.tool()
async def library_search(query: str) -> str:
    """Search movies/series by name (TMDB via Jellyseerr). Each result:
    mediaType ('movie'|'tv'), tmdbId, title, year, status, overview,
    posterUrl. status: available = watchable now; partially_available = some
    seasons only; downloading = already requested, in progress;
    not_requested = not in the library (offer media_add); pending_approval =
    rare, requests auto-approve here. ALWAYS call this before media_add or
    before answering 'do we have X'. Empty results = no such title in TMDB —
    say so; never invent a title, year, or tmdbId."""
    try:
        return _dumps(await jellyseerr.search(query))
    except Exception as err:
        return f"library_search failed: {err}"


@mcp.tool()
async def media_add(media_type: str, tmdb_id: int, jellyseerr_user_id: int | None = None, seasons: list[int] | None = None) -> str:
    """Request a movie or ONE season of a series; it is AUTO-APPROVED and
    starts downloading immediately — never tell the user it awaits approval.
    media_type 'movie'|'tv'; tmdb_id MUST come from a library_search result in
    this conversation, never from memory. tv: exactly one season per call
    (seasons=[N]) — ask which season before calling. Always pass
    jellyseerr_user_id so the request is attributed to the requester.
    Confirm intent before calling; this kicks off a real download."""
    if media_type not in ("movie", "tv"):
        return "media_type must be 'movie' or 'tv'"
    if media_type == "tv" and seasons and len(seasons) > 1:
        return "Solo puedes pedir 1 temporada a la vez. Elige cuál quieres primero."
    try:
        return _dumps(await jellyseerr.request_media(media_type, tmdb_id, jellyseerr_user_id, seasons))
    except Exception as err:
        return f"media_add failed: {err}"


@mcp.tool()
async def media_file_info(tmdb_id: int) -> str:
    """Details of the downloaded file(s) for a movie or series — auto-detects
    which. Movie: quality, resolution, codecs, audioLanguages, subtitles,
    size_gb, monitored. Series: episodesWithFile count, total size_gb, distinct
    videoCodecs, audioCodecs, audioLanguages, subtitle languages across all
    episode files. tmdb_id from library_search. MANDATORY before any claim
    about audio language or quality — never assume or guess.
    hasFile=false = in the library but no file downloaded yet."""
    try:
        movie, series = await asyncio.gather(
            arr_media.movie_file_info(tmdb_id),
            arr_media.series_file_info(tmdb_id),
        )
        if "error" not in movie:
            return _dumps(movie)
        if "error" not in series:
            return _dumps(series)
        return _dumps(movie)  # both errored — return movie error
    except Exception as err:
        return f"media_file_info failed: {err}"


@mcp.tool()
async def my_requests(jellyseerr_user_id: int) -> str:
    """All requests made by ONE user (jellyseerr_user_id comes in your context).
    Shows title, type, status (available/downloading/pending) and date. Use for
    'qué he pedido / mis pedidos' — and to VERIFY OWNERSHIP before deleting a
    torrent with downloads_delete on behalf of a non-admin user."""
    try:
        return _dumps(await jellyseerr.user_requests(jellyseerr_user_id))
    except Exception as err:
        return f"my_requests failed: {err}"


@mcp.tool()
@cached(30)
async def downloads_status() -> str:
    """Current qBittorrent torrents: name, hash, state, progress %, speed,
    ETA, size. For 'cómo van las descargas'. The hash here is what
    downloads_control/downloads_delete need. Torrent names are raw release
    filenames — match them to titles carefully; if unsure which torrent
    corresponds to a title, say so instead of guessing."""
    try:
        return _dumps(await qbittorrent.torrents())
    except Exception as err:
        return f"downloads_status failed: {err}"


@mcp.tool()
async def downloads_control(action: str, torrent_hash: str = "all", jellyseerr_user_id: int | None = None) -> str:
    """Pause or resume torrents. action 'pause'|'resume'; torrent_hash from a
    downloads_status result, or 'all' (admin only — refused in restricted mode).
    Always pass the speaker's jellyseerr_user_id: in restricted mode ownership
    is ENFORCED IN CODE — hashes not matching that user's own active requests
    are refused and NOT acted upon (tell them only Marco can control those).
    Deletes nothing."""
    try:
        if os.environ.get("MEDIAOPS_PROFILE") == "restricted":
            if not jellyseerr_user_id:
                return _dumps({
                    "error": "jellyseerr_user_id is required to verify torrent ownership",
                })
            if torrent_hash == "all":
                return _dumps({
                    "error": "pausing/resuming all torrents is admin-only — only Marco can do that",
                })
            owned_ids, by_hash = await asyncio.gather(
                jellyseerr.user_request_tmdb_ids(jellyseerr_user_id),
                arr_media.queue_tmdb_by_hash(),
            )
            info = by_hash.get(torrent_hash.lower())
            if not info or info["tmdbId"] not in owned_ids:
                return _dumps({
                    "refused": torrent_hash,
                    "title": (info or {}).get("title"),
                    "reason": "not requested by this user (or not verifiable) — only Marco can control it",
                })
        return await qbittorrent.control(action, torrent_hash)
    except Exception as err:
        return f"downloads_control failed: {err}"


@mcp.tool()
async def downloads_clean() -> str:
    """Remove ALL completed torrents from qBittorrent. Downloaded files are
    KEPT — the movies/series stay watchable; this only clears the torrent
    list and stops seeding. For 'limpia los torrents terminados'."""
    try:
        return _dumps(await qbittorrent.delete_completed(delete_files=False))
    except Exception as err:
        return f"downloads_clean failed: {err}"


@mcp.tool()
async def downloads_delete(hashes: list[str], jellyseerr_user_id: int | None = None) -> str:
    """Remove SPECIFIC torrents by hash (downloaded files are KEPT). hashes
    ONLY from a downloads_status result in this conversation. Always pass the
    speaker's jellyseerr_user_id (it's in your context): in restricted mode
    ownership is ENFORCED IN CODE — hashes not matching that user's own
    active requests come back in 'refused' and are NOT deleted (tell them
    only Marco can remove those). Typical dead-download flow: downloads_status
    → downloads_delete → media_search_release."""
    try:
        if os.environ.get("MEDIAOPS_PROFILE") == "restricted":
            if not jellyseerr_user_id:
                return _dumps({
                    "deleted": 0,
                    "error": "jellyseerr_user_id is required to verify torrent ownership",
                })
            owned_ids, by_hash = await asyncio.gather(
                jellyseerr.user_request_tmdb_ids(jellyseerr_user_id),
                arr_media.queue_tmdb_by_hash(),
            )
            allowed, refused = [], []
            for h in hashes:
                info = by_hash.get(h.lower())
                if info and info["tmdbId"] in owned_ids:
                    allowed.append(h)
                else:
                    refused.append({
                        "hash": h,
                        "title": (info or {}).get("title"),
                        "reason": "not requested by this user (or not verifiable) — only Marco can remove it",
                    })
            result = {"refused": refused}
            if allowed:
                result.update(await qbittorrent.delete_torrents(allowed, delete_files=False))
            else:
                result["deleted"] = 0
            return _dumps(result)
        return _dumps(await qbittorrent.delete_torrents(hashes, delete_files=False))
    except Exception as err:
        return f"downloads_delete failed: {err}"


@mcp.tool()
async def media_search_release(tmdb_id: int) -> str:
    """Tell Radarr to search for another release of a movie. tmdb_id from
    library_search. Use after removing a stalled torrent, or when hunting a
    different quality/audio version. The search is ASYNC: say 'search
    started, it will download if something is found' — never promise results
    or invent what was found."""
    try:
        return _dumps(await arr_media.search_movie(tmdb_id))
    except Exception as err:
        return f"media_search_release failed: {err}"


@mcp.tool()
async def media_queue() -> str:
    """Radarr+Sonarr import queues: what is downloading/importing right now,
    with per-item errors (stuck imports, failed downloads). First stop for
    'por qué no ha llegado X'. Complements downloads_status: this is the ARR
    import view, that is the raw torrent view."""
    try:
        return _dumps(await arr_media.import_queues())
    except Exception as err:
        return f"media_queue failed: {err}"


@mcp.tool()
async def library_missing(limit: int = 15) -> str:
    """Monitored but not yet downloaded: movies (Radarr) and aired episodes
    (Sonarr). These are wanted and download automatically when a valid
    release appears — being listed here is NOT an error by itself."""
    try:
        return _dumps(await arr_media.missing(limit))
    except Exception as err:
        return f"library_missing failed: {err}"


@mcp.tool()
async def subtitles_missing(limit: int = 20) -> str:
    """Items missing subtitles per Bazarr, with the missing languages AND the
    exact ids that subtitles_search needs (radarrId for movies,
    sonarrSeriesId for series episodes). Always call this first — those ids
    cannot be guessed and are NOT tmdbIds."""
    try:
        return _dumps(await bazarr.wanted(limit))
    except Exception as err:
        return f"subtitles_missing failed: {err}"


@mcp.tool()
async def subtitles_search(media_type: str, item_id: int) -> str:
    """Search Bazarr for missing subtitles. media_type 'movie' (item_id =
    radarrId) or 'series' (item_id = sonarrSeriesId — checks/searches ALL
    episodes of that series); ids ONLY from subtitles_missing — never a
    tmdbId. ALWAYS checks current subtitle state first (code-enforced, not
    just a prompt rule) — if everything is already present it returns
    action='already_has_subtitles' with the list and does NOT trigger a
    search, avoiding a pointless Bazarr run. Otherwise triggers
    search-missing and returns action='search_triggered' — Bazarr downloads
    the best match by itself, may take minutes, and can find nothing: say
    'búsqueda iniciada', never promise or claim the subtitle was found."""
    try:
        if media_type == "movie":
            status = await bazarr.movie_subtitle_status(item_id)
        elif media_type in ("series", "episode"):
            status = await bazarr.series_subtitle_status(item_id)
        else:
            return "media_type must be 'movie' or 'series'"

        if not status["found"]:
            return _dumps({"error": f"{media_type} with id {item_id} not found in Bazarr"})

        if not status["missing"]:
            return _dumps({
                "action": "already_has_subtitles",
                "present": status["present"],
            })

        if media_type == "movie":
            await bazarr.search_movie(item_id)
        else:
            await bazarr.search_series(item_id)
        return _dumps({
            "action": "search_triggered",
            "was_missing": status["missing"],
            "already_present": status["present"],
        })
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
    """Normalization backlog (Media Manager): counts by status, pending files
    each with the file_id that optimization_run needs, files with errors,
    current CPU and active job count. Statuses: needs-fix = wrong default
    audio track (fast), no-aac = audio re-encode (minutes), needs-video =
    full H.264 re-encode (30-90 min). rescan=True re-analyzes every file
    (slow) — default uses the last scan. NEVER use these counts to judge
    whether a job you started earlier worked: a finished job is checked ONLY
    via optimization_job(job_id) — its log ends in OK: or ERROR:."""
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
    later; do NOT wait for completion. Returns a job_id for optimization_job.
    ALWAYS quote the job_id verbatim in your visible reply — a later message
    can only check the job if the id survived in the conversation. You have
    NO scheduler and NO way to chain jobs: never claim you will run the next
    one automatically; the user must ask again when this one finishes."""
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
    """Who is watching Jellyfin RIGHT NOW: user, device, title, direct play vs
    transcoding. Check before heavy operations (restarts, re-encodes) so you
    don't interrupt someone. Empty = nobody is watching."""
    try:
        return _dumps(await analytics.jellyfin_sessions())
    except Exception as err:
        return f"streaming_sessions failed: {err}"


@mcp.tool()
async def analytics_storage() -> str:
    """Disk usage: filesystems (media mount /mnt/ADATA) plus size per media
    folder (películas, series, torrents). For 'cuánto espacio queda / qué
    ocupa más'. Read-only; report only the numbers it returns."""
    try:
        return _dumps(await analytics.storage())
    except Exception as err:
        return f"analytics_storage failed: {err}"


@mcp.tool()
async def analytics_library() -> str:
    """Library TOTALS: movie count, series with episode completeness, size on
    disk. For 'cuántas películas tenemos'. For the actual list of titles use
    library_catalog instead."""
    try:
        return _dumps(await analytics.library_summary())
    except Exception as err:
        return f"analytics_library failed: {err}"


@mcp.tool()
async def library_by_audio_language(language: str) -> str:
    """Movies AND series that have an audio track in the given language
    (accepts a name like 'español'/'inglés' or a raw 3-letter code like
    'spa'/'eng'). Checks REAL per-item audio data from Radarr/Sonarr, not a
    guess — items with no audio info at all are excluded, never assumed to
    match. Use for 'qué tengo en español', 'muéstrame las series con audio
    en inglés', etc. Each result includes tmdbId for follow-up (media_file_info,
    seasons_info...)."""
    try:
        return _dumps(await analytics.library_by_audio_language(language))
    except Exception as err:
        return f"library_by_audio_language failed: {err}"


@mcp.tool()
@cached(60)
async def library_catalog() -> str:
    """Full list of movies and series with files actually downloaded (i.e.
    watchable now). For 'qué tenemos / muéstrame el catálogo'. The output is
    large: summarize by groups (🎬/📺, or A-M / N-Z), don't dump every title.
    A title absent here can still exist in TMDB — check library_search before
    saying it doesn't exist at all."""
    try:
        return _dumps(await analytics.library_catalog())
    except Exception as err:
        return f"library_catalog failed: {err}"


@mcp.tool()
async def memory_recall() -> str:
    """GLOBAL server preferences and standing decisions (e.g. 'audio latino
    preferido', 'nada mayor a 8GB'). Check before media/quality decisions.
    This is the server-wide memory — per-person facts arrive in your context,
    not here."""
    try:
        return _dumps(memory.recall())
    except Exception as err:
        return f"memory_recall failed: {err}"


@mcp.tool()
async def memory_save(note: str) -> str:
    """Persist a GLOBAL server preference or standing decision for future
    sessions. Only durable policies ('prefer X', 'never Y'), never one-off
    events or per-person facts."""
    try:
        return memory.save(note)
    except Exception as err:
        return f"memory_save failed: {err}"


@mcp.tool()
async def recently_added(limit: int = 10, days: int = 30) -> str:
    """Movies and series with files added to the library in the last N days
    (default last 30 days), sorted newest first. Use for '¿qué hay de nuevo
    esta semana/mes?' without loading the full catalog. Each item: mediaType,
    title, year, tmdbId, dateAdded."""
    try:
        return _dumps(await arr_media.recently_added(limit, days))
    except Exception as err:
        return f"recently_added failed: {err}"


@mcp.tool()
async def seasons_info(tmdb_id: int) -> str:
    """Season breakdown for a TV series in Sonarr: each season's total episode
    count, how many are downloaded, and % complete. tmdb_id from library_search.
    Call before media_add to show which seasons are already available so the
    user can choose which one to request. season=0 (specials) is excluded."""
    try:
        return _dumps(await arr_media.seasons_info(tmdb_id))
    except Exception as err:
        return f"seasons_info failed: {err}"


@mcp.tool()
async def fix_stalled_downloads() -> str:
    """Find torrents CONFIRMED stalled (stalledDL/error/metaDL state, progress
    < 100%, seen in that state across multiple consecutive 20-min checks — a
    single reading is not enough, qBittorrent's stalledDL/metaDL can flicker
    for seconds on a peer blip), delete them from qBittorrent WITH their partial
    files (a re-search rarely grabs the identical release, so the partial
    almost never helps a resume — it just wastes disk sitting there), and
    trigger a new Radarr/Sonarr search. Torrents at 90%+ progress need a much
    longer confirmed-stalled window before being touched, since losing that
    much progress to a false positive is costly and near-complete torrents
    are the most likely to self-recover. Ignores torrents at 100% (already on
    disk) AND anything Radarr/Sonarr has unmonitored (that flag means the
    user or a past decision already said 'stop chasing this' — this tool
    must never override it by force-searching anyway, see
    'skipped_unmonitored' in the result). Available to all users. Returns
    fixed items, or a message if nothing was stalled long enough yet — check
    'watching' for torrents seen stalled but not yet past their confirmation
    window."""
    try:
        all_torrents, by_hash = await asyncio.gather(
            qbittorrent.torrents(),
            arr_media.queue_tmdb_by_hash(),
        )
        # metaDL = magnet stuck fetching metadata: it can't even find a peer
        # holding the .torrent, so it's as dead as (often deader than)
        # stalledDL — a re-search that grabbed another seedless latino magnet
        # lands here and stays invisible forever unless we include it (found
        # 2026-07-14: About Time / Rocketman sat in metaDL for hours untouched).
        # The time-confirmation below still protects a briefly-normal metaDL
        # (a fresh magnet resolves metadata in seconds, well under the window).
        candidates = {
            t["hash"].lower(): t for t in all_torrents
            if t["state"] in ("stalledDL", "error", "metaDL") and t["progress"] < 100.0
        }

        state = _load_stalled_state()
        now = time.time()
        to_fix = []
        watching = []
        skipped_unmonitored = []
        for h, t in candidates.items():
            info = by_hash.get(h)
            # Respect Radarr/Sonarr's own monitored flag: if the user (or a
            # past failure) already told the *arr to stop chasing this item,
            # our auto-fix must not override that by force-searching anyway.
            # This is exactly what kept re-grabbing the same seedless
            # Trainspotting release for days (2026-07-10): the movie was
            # unmonitored (its 4K file had been moved off-library, Radarr
            # correctly stopped hunting it) but fix_stalled_downloads called
            # search_movie() unconditionally regardless of that flag.
            if info and info.get("monitored") is False:
                state.pop(h, None)
                skipped_unmonitored.append(info.get("title") or t["name"])
                continue
            required = STALL_CONFIRM_SECONDS_HIGH if t["progress"] >= HIGH_PROGRESS else STALL_CONFIRM_SECONDS
            first_seen = state.get(h, {}).get("first_seen")
            title = (info or {}).get("title") or t["name"]
            if first_seen is None:
                state[h] = {"first_seen": now, "progress_at_first_seen": t["progress"]}
                watching.append({"title": title, "progress": t["progress"], "confirms_in_minutes": round(required / 60)})
                continue
            elapsed = now - first_seen
            if elapsed >= required:
                to_fix.append(t)
            else:
                watching.append({
                    "title": title,
                    "progress": t["progress"],
                    "stalled_for_minutes": round(elapsed / 60, 1),
                    "confirms_in_minutes": round((required - elapsed) / 60, 1),
                })
        # Stop watching anything no longer a candidate (recovered or gone)
        for h in list(state.keys()):
            if h not in candidates:
                del state[h]

        if not to_fix:
            _save_stalled_state(state)
            msg = "No hay torrents confirmados como estancados"
            result = {"fixed": 0, "message": msg}
            if watching:
                result["watching"] = watching
            if skipped_unmonitored:
                result["skipped_unmonitored"] = skipped_unmonitored
            return _dumps(result)

        fixed = []
        errors = []
        for t in to_fix:
            info = by_hash.get(t["hash"].lower())
            if not info:
                del state[t["hash"].lower()]
                continue
            # Each item gets its own try/except: an unexpected failure on one
            # torrent (e.g. a Jellyseerr hiccup on the requester lookup) must
            # never erase the record of others already deleted+re-searched in
            # this same run — that's exactly what hid a real incident
            # 2026-07-08 (a crash on 'Rocketman' mid-loop turned the whole run
            # into a bare error string, silently swallowing whatever had
            # already been fixed, with zero notification to anyone).
            try:
                await qbittorrent.delete_torrents([t["hash"]], delete_files=True)
                del state[t["hash"].lower()]
                if info["app"] == "radarr":
                    search = await arr_media.search_movie(info["tmdbId"])
                else:
                    search = await arr_media.search_series(info["tmdbId"])
                item = {
                    "title": info["title"],
                    "app": info["app"],
                    "tmdbId": info["tmdbId"],
                    "state_was": t["state"],
                    "progress_was": t["progress"],
                    "search": search.get("status", "unknown"),
                }
                try:
                    requester = await jellyseerr.requester_by_tmdb(info["tmdbId"])
                    if requester:
                        item["requestedBy"] = requester
                except Exception as err:
                    item["requestedBy_error"] = str(err)
                fixed.append(item)
            except Exception as err:
                errors.append({"title": info.get("title"), "tmdbId": info.get("tmdbId"), "error": str(err)})
        _save_stalled_state(state)
        result = {"fixed": len(fixed), "items": fixed}
        if errors:
            result["errors"] = errors
        if watching:
            result["watching"] = watching
        if skipped_unmonitored:
            result["skipped_unmonitored"] = skipped_unmonitored
        return _dumps(result)
    except Exception as err:
        return f"fix_stalled_downloads failed: {err}"


@mcp.tool()
async def media_remove(tmdb_id: int, delete_files: bool = False) -> str:
    """Remove a movie from Radarr (stops monitoring it). Keeps the file on disk
    by default (delete_files=False) — only pass True when the user explicitly
    wants to free disk space and confirms it. tmdb_id from library_search.
    Series removal is not yet implemented."""
    try:
        return _dumps(await arr_media.remove_movie(tmdb_id, delete_files))
    except Exception as err:
        return f"media_remove failed: {err}"


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="MediaOps MCP server")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio",
                        help="Transport to use (default: stdio)")
    parser.add_argument("--port", type=int, default=None,
                        help="Port for SSE transport (overrides FASTMCP_PORT)")
    args, _ = parser.parse_known_args()

    if args.port is not None:
        os.environ["FASTMCP_PORT"] = str(args.port)
        mcp.settings.port = args.port
    if args.transport == "sse":
        os.environ.setdefault("FASTMCP_HOST", "127.0.0.1")
        mcp.settings.host = os.environ["FASTMCP_HOST"]

    mcp.run(transport=args.transport)


if __name__ == "__main__":
    main()
