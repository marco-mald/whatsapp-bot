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
| `mcp/` | `mediaops` MCP server — 27 tools over the whole stack | Python ≥3.11, uv venv |
| `~/Downloads/media_manager` | Audio/video normalizer (separate repo, has its own README) | pm2 (`media-manager`) |

## Interaction model — natural language only

There are no `!` commands. Everything is conversational, with zero-trust access
tiers enforced at the platform level (per-run MCP tool allowlists, not prompts):

| Surface | Who | Mode | Capabilities |
|---|---|---|---|
| Admin DM + group named `Debug` (`ADMIN_GROUP_NAME`) | `ADMIN_NUMBER` only | `full` | Everything: all 27 tools + unrestricted CLI |
| Any other group — only when the bot is **@mentioned** or its message is quoted | Registered users | `restricted` | Query + request media + add subtitles: `library_search`, `media_add`, `downloads_status`, `media_queue`, `library_missing`, `system_status`, `subtitles_missing`, `subtitles_search` |
| DMs from registered non-admin users | Registered users | `restricted` | Same as above |
| Unknown numbers | — | — | Ignored entirely |

- Requests are attributed: each run carries the speaker's identity, and
  `media_add` is called with their `jellyseerr_user_id`.
- Conversations keep context per chat+user for 20 min (`exit()` or `reset` to clear).
- Every agent run costs money — that's why groups require a mention and unknown
  numbers are dropped silently.
- Rate limiting ([src/ratelimit.js](src/ratelimit.js)): one run at a time per
  user (single-flight — a second message while one is in flight gets a "wait"
  reply), global cap `MAX_CONCURRENT_RUNS` (default 2, protects CPU/streaming),
  and a generous soft daily cap `DAILY_MSG_LIMIT` (default 40). The admin is
  exempt from the global and daily caps.
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

- **Push notifications** (to `TARGET_CHAT_ID`, the group; DMs don't work):
  request approved 📥, media available 🍿 (with poster and requester),
  download failed ❌, technical errors ⚠️. Sources: Radarr/Sonarr/Jellyseerr
  webhooks registered as "Marcobot" pointing to `:3010/hooks/<source>?token=…`.
- **Automatic diagnosis**: failure events trigger a Claude run (MCP-locked,
  max 1 per 30 min, 6 h dedupe) that posts probable cause + suggested action.
- **Quiet hours** (`QUIET_HOURS`, default 22:00–08:00): notifications queue in
  `data/notify-queue.json` and arrive as one morning digest 🌙.
- **Night optimizer** (`OPTIMIZE_WINDOW`, default 01:00–08:00): normalizes the
  Media Manager backlog one file at a time — only if no job is running AND
  nobody is streaming on Jellyfin. Priority: needs-fix → no-aac → needs-video.
  Failed files are remembered and skipped (`data/optimizer-state.json`).
  Morning summary 🔧 to the group.
- **Sunday 11:00**: trending suggestions with posters (`TIMEZONE`).

## MCP server (`mcp/`)

27 tools in `mediaops`, grouped by module:

| Module | Tools |
|---|---|
| system | `system_status`, `system_logs`, `system_restart`, `system_resources` |
| diagnostics | `diagnostics_health`, `diagnostics_explain` |
| requests | `library_search`, `media_add`, `requests_pending`, `requests_manage` |
| downloads | `downloads_status`, `downloads_control` |
| media | `media_queue`, `library_missing` |
| subtitles | `subtitles_missing`, `subtitles_search` |
| indexers | `indexers_health`, `indexers_test` |
| optimization | `optimization_report`, `optimization_run`, `optimization_job`, `optimization_cancel` |
| streaming | `streaming_sessions` |
| analytics | `analytics_storage`, `analytics_library` |
| memory | `memory_recall`, `memory_save` |

Notes:

- Credentials are read at call time — ARR API keys from `~/arrstack/<svc>/config.xml`,
  Bazarr key from its `config.yaml`, the rest from this repo's `.env`. Nothing cached.
- `optimization_run` is strictly sequential (refuses if a job is active) so a
  batch request can never melt the host.
- Claude modes in [src/services/claudeApi.js](src/services/claudeApi.js):
  `full` (admin surfaces, `--dangerously-skip-permissions`), `restricted`
  (least-privilege tool allowlist), `mediaops` (all MCP tools, nothing else —
  used by the automatic failure diagnosis).

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
(group JID for notifications), `TIMEZONE`, `ADMIN_NUMBER`, `ADMIN_GROUP_NAME`
(default `Debug`), `ADMIN_CHAT_IDS` (optional extra admin chat JIDs),
`WEBHOOK_PORT/TOKEN`, `QUIET_HOURS`, `JELLYFIN_URL/API_KEY`, `OPTIMIZE_WINDOW`.

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

- `users.local.json` — WhatsApp phone → Jellyseerr account map (see src/users.js)
- `notify-queue.json` — notifications held during quiet hours
- `optimizer-state.json` — night worker state (current job, failed files, night stats)
- `preferences.json` — agent memory (standing decisions, preferences)
