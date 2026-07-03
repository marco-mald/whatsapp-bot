"""Runtime layer: process state, logs, and restarts for docker/systemd/pm2.

All subprocess calls are async, time-bounded, and never receive user input as
shell strings — arguments come from the inventory, plus a validated int for
log line counts.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from ..inventory import Runtime, Service

MAX_LOG_LINES = 200


class CommandError(RuntimeError):
    pass


async def _run(*argv: str, timeout: float = 15.0) -> str:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise CommandError(f"timeout running {argv[0]}")
    text = out.decode(errors="replace").strip()
    if proc.returncode != 0:
        raise CommandError(text or f"{argv[0]} exited {proc.returncode}")
    return text


@dataclass
class ProcessState:
    running: bool
    detail: str
    restarts: int | None = None


async def _docker_state(container: str) -> ProcessState:
    out = await _run(
        "docker", "inspect", container,
        "--format", "{{.State.Status}}\t{{.State.Restarting}}\t{{.RestartCount}}\t{{.State.StartedAt}}",
    )
    status, restarting, restart_count, started_at = out.split("\t")
    running = status == "running" and restarting != "true"
    detail = f"{status}, started {started_at[:19]}"
    return ProcessState(running, detail, int(restart_count))


async def _systemd_state(unit: str) -> ProcessState:
    out = await _run(
        "systemctl", "show", unit,
        "--property=ActiveState,SubState,NRestarts,ExecMainStartTimestamp",
    )
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    active = props.get("ActiveState", "unknown")
    detail = f"{active}/{props.get('SubState', '?')}, started {props.get('ExecMainStartTimestamp', '?')}"
    restarts = int(props["NRestarts"]) if props.get("NRestarts", "").isdigit() else None
    return ProcessState(active == "active", detail, restarts)


async def _pm2_state(name: str) -> ProcessState:
    out = await _run("pm2", "jlist")
    # pm2 may prepend log noise before the JSON array
    payload = out[out.index("["):] if "[" in out else "[]"
    for proc in json.loads(payload):
        if proc.get("name") == name:
            env = proc.get("pm2_env", {})
            status = env.get("status", "unknown")
            return ProcessState(status == "online", status, env.get("restart_time"))
    return ProcessState(False, "not found in pm2")


async def process_state(svc: Service) -> ProcessState:
    try:
        if svc.runtime is Runtime.DOCKER:
            return await _docker_state(svc.unit)
        if svc.runtime is Runtime.SYSTEMD:
            return await _systemd_state(svc.unit)
        return await _pm2_state(svc.unit)
    except CommandError as err:
        return ProcessState(False, str(err))


def _clamp_lines(lines: int) -> int:
    return max(1, min(int(lines), MAX_LOG_LINES))


async def service_logs(svc: Service, lines: int = 50) -> str:
    n = str(_clamp_lines(lines))
    if svc.runtime is Runtime.DOCKER:
        return await _run("docker", "logs", svc.unit, "--tail", n)
    if svc.runtime is Runtime.SYSTEMD:
        return await _run("journalctl", "-u", svc.unit, "-n", n, "--no-pager")
    return await _run("pm2", "logs", svc.unit, "--lines", n, "--nostream", timeout=20.0)


async def restart_service(svc: Service) -> str:
    if svc.runtime is Runtime.DOCKER:
        return await _run("docker", "restart", svc.unit, timeout=60.0)
    if svc.runtime is Runtime.SYSTEMD:
        # Covered by a scoped NOPASSWD sudoers rule for exactly this command
        return await _run("sudo", "-n", "/bin/systemctl", "restart", svc.unit, timeout=60.0)
    return await _run("pm2", "restart", svc.unit, timeout=30.0)


async def host_resources() -> dict:
    disk_raw, mem_raw, load_raw = await asyncio.gather(
        _run("df", "-h", "--output=target,size,used,avail,pcent",
             "--exclude-type=tmpfs", "--exclude-type=devtmpfs", "--exclude-type=squashfs"),
        _run("free", "-h"),
        _run("cat", "/proc/loadavg"),
    )
    return {"disk": disk_raw, "memory": mem_raw, "loadavg": load_raw}
