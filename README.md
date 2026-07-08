# Marcobot — AI MediaOps Platform

WhatsApp bot + MCP server that manages a personal media stack (Jellyfin, Radarr,
Sonarr, Prowlarr, Bazarr, Jellyseerr, qBittorrent, Media Manager) through
deterministic commands, natural language via Claude, push events, and autonomous
night maintenance.

```
WhatsApp (quiet hours 22:00–08:00)
   ├── Natural language ─────── every interaction → Claude Code CLI → MCP tools
   │     ├─ admin surfaces (admin DM + "Debug" group): full toolset
   │     └─ everyone else (@mention in groups): least-privilege toolset
   ├── Webhooks (:3010) ─────── Radarr/Sonarr/Jellyseerr push → notifications
   │                            └─ failures → automatic Claude diagnosis
   └── Night optimizer ──────── drains normalization backlog 01:00–08:00
```

The AI never talks to services directly: agent runs are locked to the MCP tools
(`--strict-mcp-config`), so every capability is typed, scoped, and auditable.

## Components

| Path | What | Runtime |
|---|---|---|
| `src/` | WhatsApp bot (Baileys), command router, webhooks, notifications, night optimizer | Node ≥18, pm2 (`marcobot`) |
| `mcp/` | `mediaops` MCP server — 32 tools over the whole stack | Python ≥3.11, uv venv |
| `~/Downloads/media_manager` | Audio/video normalizer (separate repo, has its own README) | pm2 (`media-manager`) |

## Interaction model — natural language only

There are no `!` commands. Everything is conversational, with zero-trust access
tiers enforced at the platform level (per-run MCP tool allowlists, not prompts):

**DMs are disabled entirely** — delivery to direct messages proved unreliable
(replies get silently stuck as PENDING), and it was a recurring source of
confusion (someone taps the bot's contact meaning to address the group
instead). The bot only reacts inside groups:

| Surface | Who | Mode | Capabilities |
|---|---|---|---|
| Group named `Debug` (`ADMIN_GROUP_NAME`) | `ADMIN_NUMBER` only | `full` | All 32 mediaops tools, stronger model (`CLAUDE_MODEL_ADMIN`) — but no raw Claude Code builtins (Bash/Write/Edit/Cron/Task/WebFetch). Decided 2026-07-06: unrestricted shell/cron access triggered by a WhatsApp message was an unaudited blast radius, and having real scheduling tools around is what made the model hallucinate "programé una revisión en 20 min" credible. |
| Any other group — only when the bot is **@mentioned** or its message is quoted | Registered users | `restricted` | The 17 family tools (see MCP server table below) — query, request media, manage their own downloads, subtitles. `downloads_delete` and `downloads_control` only on content they requested (enforced in code). |
| Unknown numbers | — | — | Ignored entirely |
| Any DM (including the admin's own) | — | — | Ignored entirely |

- Requests are attributed: each run carries the speaker's identity, and
  `media_add` is called with their `jellyseerr_user_id`.
- Conversation continuity ([src/history.js](src/history.js)): a finite rolling
  window (last 6 messages, ~400 chars each) per chat+user, persisted in
  `data/chat-history.json` — no time limit, so "descarga los subtítulos" works
  the same 2 minutes or 2 hours after the bot described a movie. The window
  is injected into each run flagged as *use only if the current message
  clearly continues it* (self-contained commands ignore it; real ambiguity →
  ask). Replying (quoting) a specific message additionally passes the quoted
  text, so the referent is explicit even beyond the window. `exit()` or
  `reset` clears it. No CLI `--resume` sessions — every run is fresh, keeping
  context tokens bounded.
- Every agent run costs money — that's why groups require a mention and unknown
  numbers are dropped silently.
- Rate limiting ([src/ratelimit.js](src/ratelimit.js)): one run at a time per
  user (single-flight — a second message while one is in flight gets a "wait"
  reply), global cap `MAX_CONCURRENT_RUNS` (default 4, protects CPU/streaming),
  per-group soft daily cap `GROUP_DAILY_LIMIT` (default 100), and a generous
  soft daily cap `DAILY_MSG_LIMIT` (default 40) per user. The admin is exempt
  from the global and daily caps.
- Off-topic moderation ([src/moderation.js](src/moderation.js)): the bot is for
  media, not banter. The LLM escalates a user who keeps messing around — warn →
  roast → append a `[[TIMEOUT:15]]` control token. The handler enforces the ban
  deterministically (timed-out users are dropped silently for 15 min) and strips
  the token from the reply. Admin is immune; bans are in-memory (reset on restart).
- Registered users live in `data/users.local.json` (gitignored; phone →
  Jellyseerr account, loaded by [src/users.js](src/users.js)).
- Chat JIDs show up in the pm2 logs (`[NL] <user> (mode) @ <jid>: ...`) — use
  that to discover a group's ID for `TARGET_CHAT_ID` / `ADMIN_CHAT_IDS`.

## Automatic behavior

- **Push notifications** (DMs don't work; everything goes to groups), routed
  by audience:
  - *Request lifecycle* (approved 📥, available 🍿, failed ❌) goes **only to
    the requester's group** — each user in `data/users.local.json` has a
    `notifyChatId`; unknown requesters fall back to the Debug group. The
    "available" notice @-mentions the requester (real WhatsApp mention).
  - *Technical/admin* (health errors ⚠️, stuck downloads, automatic diagnosis
    🧠, night-optimizer summary 🔧) goes **only to `ADMIN_CHAT_ID`** (Debug).
  - Sources: Radarr/Sonarr/Jellyseerr webhooks registered as "Marcobot"
    pointing to `:3010/hooks/<source>?token=…`. `TARGET_CHAT_ID` remains the
    default for broadcasts (e.g. Sunday trending).
- **Automatic diagnosis**: failure events trigger a Claude run (MCP-locked,
  max 1 per 30 min, 6 h dedupe) that posts probable cause + suggested action.
- **Quiet hours** (`QUIET_HOURS`, default 22:00–08:00): notifications queue in
  `data/notify-queue.json` and arrive as one morning digest 🌙.
- **Night optimizer** (`OPTIMIZE_WINDOW`, default 01:00–08:00): the ONLY
  normalization path (decided 2026-07-04 — Media Manager's webhook no longer
  normalizes inline; it just refreshes Jellyfin immediately so availability
  notifications aren't delayed by 30-90 min encodes). Normalizes the
  Media Manager backlog one file at a time — only if no job is running AND
  nobody is streaming on Jellyfin. Priority: needs-fix → no-aac → needs-video.
  Failed files are remembered and skipped (`data/optimizer-state.json`).
  Morning summary 🔧 to the group.
- **Sunday 11:00**: trending suggestions with posters (`TIMEZONE`).
- **Daily 09:00**: download activity summary sent to all `TARGET_CHAT_ID` groups (via `sendDailySummary` in [src/scheduler.js](src/scheduler.js)).
- **Reconnection resilience** ([src/bot.js](src/bot.js)):
  - *Exponential backoff with jitter* on `connection === 'close'`: 3s → ~5s → ~10s → … → 60s cap. Resets to 3s only after 30s of stable `open` state — eliminates the 3-second hammering seen during a real network failure that can trigger WA rate-limiting.
  - *Zombie socket watchdog*: every 60s checks whether `lastActivity` (updated on every `connection.update` and `messages.upsert`) is more than 5 min old while the socket still reports `open`. If so, forces `sock.end()` to trigger normal reconnection. Catches TCP-ESTAB sessions that receive no traffic and never emit `close` (seen 2026-07-06).
  - *Reconnection storm alert*: if ≥8 closes happen within 5 min, sends a `⚠️` message to `ADMIN_CHAT_ID` (Debug group) via `notify()`. Fires once per storm at the 8th disconnect — subsequent disconnects in the same storm don't re-alert.

## MCP server (`mcp/`)

32 tools in `mediaops`, grouped by module. 👪 = also in the restricted
(family) profile; unmarked = admin/internal only:

| Module | Tools |
|---|---|
| system | `system_status` 👪, `system_logs`, `system_restart`, `system_resources` |
| diagnostics | `diagnostics_health`, `diagnostics_explain` |
| requests | `library_search` 👪, `library_trending` 👪, `library_catalog` 👪, `media_add` 👪, `media_file_info` 👪 (movies + series), `my_requests` 👪 |
| downloads | `downloads_status` 👪, `downloads_delete` 👪 (own content only), `downloads_control` 👪 (own content only), `downloads_clean`, `media_search_release` 👪 |
| media | `media_queue` 👪, `library_missing` 👪 |
| subtitles | `subtitles_missing` 👪, `subtitles_search` 👪 |
| indexers | `indexers_health`, `indexers_test` |
| optimization | `optimization_report`, `optimization_run`, `optimization_job`, `optimization_cancel` |
| streaming | `streaming_sessions` |
| analytics | `analytics_storage` 👪, `analytics_library` 👪 |
| memory | `memory_recall`, `memory_save` |

Notes:

- Credentials are read at call time — ARR API keys from `~/arrstack/<svc>/config.xml`,
  Bazarr key from its `config.yaml`, the rest from this repo's `.env`. Nothing cached.
- Requests **auto-approve**: `media_add` starts the download immediately, nothing waits for approval.
- `downloads_delete` and `downloads_control` in restricted mode: ownership enforced in code — users may only act on torrents of content they requested (verified via `queue_tmdb_by_hash` + `user_request_tmdb_ids`).
- `media_file_info` auto-detects movie vs series: queries Radarr and Sonarr in parallel, returns whichever has the file. Series returns aggregate codec/audio/subtitle info across all episode files.
- `memory_recall`/`memory_save` are the **global** server memory (policies like
  "WEB-DL ≤8GB"), admin-only. Per-person memory is separate: the handler stores
  `[[RECUERDA:...]]` facts per phone in `data/user-memory.json` and injects them
  into that user's context.
- `optimization_run` is strictly sequential (refuses if a job is active) so a
  batch request can never melt the host.
- Token diet: non-admin runs replace Claude Code's default system prompt
  (`--system-prompt`), disable built-in tools (`--tools ""`), and load the
  `MEDIAOPS_PROFILE=restricted` server ([mediaops-restricted.mcp.json](mcp/mediaops-restricted.mcp.json))
  which only registers the 17 family tools — ~10.5K context tokens per run vs
  ~37.7K with the defaults. Keep `RESTRICTED_PROFILE_TOOLS` (server.py) and
  `RESTRICTED_TOOLS` (claudeApi.js) in sync when changing the split.
- Claude modes in [src/services/claudeApi.js](src/services/claudeApi.js):
  `full` (admin surface, stronger model, still MCP-locked — no CC builtins),
  `restricted` (least-privilege tool allowlist), `mediaops` (all MCP tools,
  nothing else — used by the automatic failure diagnosis). All three run
  with `--strict-mcp-config` + `--tools ""`: no mode ever gets Claude Code's
  own Bash/Write/Edit/Cron/Task/WebFetch — only the mediaops MCP tools.
- Deterministic backstop in [src/handler.js](src/handler.js)
  (`FALSE_PROMISE_RE`): the bot has no scheduler and no state between
  messages; if a reply still claims otherwise ("programé...", "te aviso
  cuando...") it's replaced with an honest message before sending, regardless
  of what the prompt says.

## Setup

```bash
# Bot
npm install
cp .env.example .env   # fill in (see below)
pm2 start src/bot.js --name marcobot   # scan QR on first run

# MCP server
cd mcp && uv venv && uv pip install -e .
```

`.env` keys: `JELLYSEERR_URL/API_KEY`, `QBIT_URL/USER/PASS`, `TARGET_CHAT_ID`
(group JIDs for broadcast notifications), `ADMIN_CHAT_ID` (Debug group JID —
technical notifications + fallback), `TIMEZONE`, `ADMIN_NUMBER`,
`ADMIN_GROUP_NAME` (default `Debug`), `ADMIN_CHAT_IDS` (optional extra admin
chat JIDs), `WEBHOOK_PORT/TOKEN`, `QUIET_HOURS`, `JELLYFIN_URL/API_KEY`,
`OPTIMIZE_WINDOW`, `CLAUDE_MODEL` (default model for non-admin runs),
`CLAUDE_MODEL_ADMIN` (stronger model for the admin surface), `OPTIMIZE_CONCURRENCY`
(night optimizer parallel jobs, default 2), `GROUP_DAILY_LIMIT` (soft daily cap
per group, default 100), `MAX_CONCURRENT_RUNS` (global concurrency cap, default 4).

One-time host config:

- Sudoers rule (Jellyfin runs on systemd, everything else is Docker/pm2):
  `<user> ALL=(ALL) NOPASSWD: /bin/systemctl restart jellyfin`
  in `/etc/sudoers.d/marcobot-jellyfin`
- Webhooks registered in Radarr/Sonarr (Settings → Connect) and Jellyseerr
  (Settings → Notifications → Webhook), name "Marcobot", URL
  `http://<host>:3010/hooks/<radarr|sonarr|jellyseerr>?token=<WEBHOOK_TOKEN>`
- Jellyseerr scans run as the dedicated Jellyfin user `jellyseerr-svc`
  (never tie them to a personal account — deleting it silently breaks
  availability detection)

## Media policy (Radarr)

Streaming-first, low disk (decided 2026-07-03):

- Profile HD-1080p: **WEB 1080p only** (preferred + cutoff), HDTV-1080p fallback.
  **Bluray disallowed entirely** — if only Bluray exists, the movie waits for a
  WEB release.
- All 1080p qualities capped at preferred 40 / max 48 MB/min (≈8 GB ceiling for
  a 167-min film; ≈6 GB for 2 h).
- Latino-audio custom format keeps its scoring.
- Target library format: H.264 8-bit + AAC 2.0 in MKV (Media Manager enforces
  it post-download) → direct play everywhere, no transcoding.

## Data files (`data/`, gitignored)

- `users.local.json` — WhatsApp phone → Jellyseerr account map (see src/users.js);
  per-user `notifyChatId` = the group that receives that user's request notifications
- `chat-history.json` — rolling conversation window per chat+user (finite, self-overwriting)
- `user-memory.json` — durable per-person facts saved via `[[RECUERDA:...]]`
- `notify-queue.json` — notifications held during quiet hours
- `optimizer-state.json` — night worker state (current job, failed files, night stats)
- `preferences.json` — agent memory (standing decisions, preferences)
- `inflight.json` — messages being processed when the bot restarts; `retryPending()` replays them on the next `connection === 'open'` (max 10 min age, after that they are discarded)
