"""Service inventory: the single source of truth about what runs on this host.

Every tool resolves services through this module; nothing else hardcodes
container names, ports, or paths.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class Runtime(str, Enum):
    DOCKER = "docker"
    SYSTEMD = "systemd"
    PM2 = "pm2"


@dataclass(frozen=True)
class Service:
    id: str
    name: str
    runtime: Runtime
    unit: str
    """Container name (docker), unit name (systemd), or process name (pm2)."""
    health_url: str
    arr_health_path: str | None = None
    """Deep health API path (needs X-Api-Key), e.g. /api/v3/health."""
    config_xml: Path | None = None
    """Where to read the ApiKey at call time — never cached, never hardcoded."""


ARRSTACK = Path.home() / "arrstack"

SERVICES: tuple[Service, ...] = (
    Service("radarr", "Radarr", Runtime.DOCKER, "radarr",
            "http://localhost:7878/ping",
            arr_health_path="http://localhost:7878/api/v3/health",
            config_xml=ARRSTACK / "radarr" / "config.xml"),
    Service("sonarr", "Sonarr", Runtime.DOCKER, "sonarr",
            "http://localhost:8989/ping",
            arr_health_path="http://localhost:8989/api/v3/health",
            config_xml=ARRSTACK / "sonarr" / "config.xml"),
    Service("prowlarr", "Prowlarr", Runtime.DOCKER, "prowlarr",
            "http://localhost:9696/ping",
            arr_health_path="http://localhost:9696/api/v1/health",
            config_xml=ARRSTACK / "prowlarr" / "config.xml"),
    Service("bazarr", "Bazarr", Runtime.DOCKER, "bazarr",
            "http://localhost:6767/"),
    Service("jellyseerr", "Jellyseerr", Runtime.DOCKER, "jellyseerr",
            "http://localhost:5055/api/v1/status"),
    Service("qbittorrent", "qBittorrent", Runtime.DOCKER, "qbittorrent",
            "http://localhost:8080/"),
    Service("jellyfin", "Jellyfin", Runtime.SYSTEMD, "jellyfin",
            "http://localhost:8096/health"),
    Service("media-manager", "MediaManager", Runtime.PM2, "media-manager",
            "http://localhost:5000/"),
)

SERVICE_IDS = tuple(s.id for s in SERVICES)


def find_service(service_id: str) -> Service | None:
    wanted = service_id.strip().lower()
    for svc in SERVICES:
        if svc.id == wanted or svc.name.lower() == wanted:
            return svc
    return None
