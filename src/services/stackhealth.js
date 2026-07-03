const SERVICES = [
  { id: 'radarr',        name: 'Radarr',       type: 'docker',  container: 'radarr',        healthUrl: 'http://localhost:7878/ping' },
  { id: 'sonarr',        name: 'Sonarr',       type: 'docker',  container: 'sonarr',        healthUrl: 'http://localhost:8989/ping' },
  { id: 'prowlarr',      name: 'Prowlarr',     type: 'docker',  container: 'prowlarr',      healthUrl: 'http://localhost:9696/ping' },
  { id: 'bazarr',        name: 'Bazarr',       type: 'docker',  container: 'bazarr',        healthUrl: 'http://localhost:6767/' },
  { id: 'jellyseerr',    name: 'Jellyseerr',   type: 'docker',  container: 'jellyseerr',    healthUrl: 'http://localhost:5055/api/v1/status' },
  { id: 'qbittorrent',   name: 'qBittorrent',  type: 'docker',  container: 'qbittorrent',   healthUrl: 'http://localhost:8080/' },
  { id: 'jellyfin',      name: 'Jellyfin',     type: 'systemd', service:   'jellyfin',      healthUrl: 'http://localhost:8096/health' },
  { id: 'media-manager', name: 'MediaManager', type: 'pm2',     process:   'media-manager', healthUrl: 'http://localhost:5000/' },
];

module.exports = { SERVICES };
