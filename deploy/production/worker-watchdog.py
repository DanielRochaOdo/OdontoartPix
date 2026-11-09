#!/usr/bin/env python3
"""Watchdog independente da imagem Docker: nao altera dados financeiros."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone
from urllib.request import urlopen

TIMER = "odontopix-worker.timer"
SERVICE = "odontopix-worker.service"
APP = "odontopix-app-1"
DB = "odontopix-db-1"
MAINTENANCE = Path("/run/odontopix-worker-maintenance")
STATE = Path("/var/lib/odontopix-worker-watchdog/state.json")
EVENTS = Path("/var/log/odontopix/worker-incidents.jsonl")
HEALTH_URL = "http://127.0.0.1:3100/api/health/db"
STALL_SECONDS = 300
SQL = """
select json_build_object(
  'active_syncs', (select count(*) from general_sync_runs
                   where status in ('queued', 'running', 'cancelling')),
  'active_jobs', (select count(*) from processing_jobs
                  where status in ('queued', 'running', 'deferred')),
  'heartbeat_age_s', (select extract(epoch from now() - min(last_heartbeat_at))
                      from general_sync_runs where status = 'running'),
  'last_progress_age_s', (select extract(epoch from now() - max(last_progress_at))
                          from processing_jobs
                          where status in ('queued', 'running', 'deferred')
                            and processing_origin = 'dashboard')
);
"""


def command(args, *, input=None, timeout=15):
    return subprocess.run(args, input=input, capture_output=True,
                          text=True, timeout=timeout, check=False)


def http_healthy():
    try:
        with urlopen(HEALTH_URL, timeout=5) as response:
            payload = json.loads(response.read())
        return response.status == 200 and payload.get("success") is True \
            and payload.get("data", {}).get("status") == "ok"
    except (OSError, ValueError, TimeoutError):
        return False


class Watchdog:
    def __init__(self, runner=command, health=http_healthy, clock=None,
                 state_path=STATE, event_path=EVENTS, maintenance=MAINTENANCE):
        self.runner = runner
        self.health = health
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.state_path = Path(state_path)
        self.event_path = Path(event_path)
        self.maintenance = Path(maintenance)

    def load(self):
        try:
            result = json.loads(self.state_path.read_text(encoding="utf-8"))
            return result if isinstance(result, dict) else {}
        except (OSError, ValueError):
            return {}

    def save(self, state):
        self.state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        staging = self.state_path.with_suffix(".tmp")
        staging.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
        os.chmod(staging, 0o600)
        os.replace(staging, self.state_path)

    def emit(self, code, **data):
        entry = {"at": self.clock().isoformat(), "event": code, **data}
        serialized = json.dumps(entry, sort_keys=True, ensure_ascii=False)
        print("[ODONTOPIX_WORKER_WATCHDOG] " + serialized, flush=True)
        self.event_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(self.event_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (serialized + "\n").encode("utf-8"))
        finally:
            os.close(fd)

    def metrics(self):
        result = self.runner([
            "docker", "exec", "-i", DB, "sh", "-lc",
            'exec psql -X -v ON_ERROR_STOP=1 -A -t '
            '-U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"'
        ], input=SQL, timeout=15)
        if result.returncode != 0:
            raise RuntimeError("Consulta de observabilidade ao PostgreSQL falhou")
        return json.loads(result.stdout.strip().splitlines()[-1])

    def run(self):
        state = self.load()
        now = self.clock()
        enabled = self.runner(["systemctl", "is-enabled", TIMER], timeout=6)
        timer_is_enabled = enabled.returncode == 0 and enabled.stdout.strip() in (
            "enabled", "enabled-runtime")
        active = self.runner(["systemctl", "is-active", TIMER], timeout=6)
        timer_is_active = active.returncode == 0 and active.stdout.strip() == "active"

        if not timer_is_active:
            if not state.get("inactive_since"):
                state["inactive_since"] = now.isoformat()
                self.emit("timer_inactive", enabled=timer_is_enabled)

            reason = None
            if self.maintenance.exists():
                reason = "maintenance_guard"
            elif not timer_is_enabled:
                reason = "timer_disabled_intentionally"
            else:
                running = self.runner(
                    ["docker", "inspect", "--format", "{{.State.Running}}", APP],
                    timeout=8
                )
                if running.returncode != 0 or running.stdout.strip() != "true":
                    reason = "application_container_not_running"
                elif not self.health():
                    reason = "application_unhealthy"

            if reason:
                if state.get("blocked_reason") != reason:
                    self.emit("timer_recovery_blocked", reason=reason)
                state["blocked_reason"] = reason
                self.save(state)
                return

            started = self.runner(["systemctl", "start", TIMER], timeout=12)
            verified = self.runner(["systemctl", "is-active", TIMER], timeout=6)
            if started.returncode != 0 or verified.stdout.strip() != "active":
                if state.get("blocked_reason") != "systemctl_start_failed":
                    self.emit("timer_recovery_failed", reason="systemctl_start_failed")
                state["blocked_reason"] = "systemctl_start_failed"
                self.save(state)
                return

            self.emit("timer_recovered", inactive_seconds=self.elapsed(state["inactive_since"]))
            state.pop("inactive_since", None)
            state.pop("blocked_reason", None)
            timer_is_active = True

        elif state.get("inactive_since"):
            self.emit("timer_restored_externally",
                      inactive_seconds=self.elapsed(state["inactive_since"]))
            state.pop("inactive_since", None)
            state.pop("blocked_reason", None)

        # Heartbeat/ultima gravacao medem inatividade operacional, nao a duracao
        # exata de chamadas ao ERP. Nunca reiniciar servicos por atraso no ERP.
        try:
            metrics = self.metrics()
            active_syncs = int(metrics.get("active_syncs") or 0)
            heartbeat_age = metrics.get("heartbeat_age_s")
            progress_age = metrics.get("last_progress_age_s")
            stalled = (active_syncs > 0
                       and heartbeat_age is not None and progress_age is not None
                       and float(heartbeat_age) >= STALL_SECONDS
                       and float(progress_age) >= STALL_SECONDS)
            if stalled and not state.get("stalled"):
                self.emit("sync_without_progress", active_syncs=active_syncs,
                          active_jobs=int(metrics.get("active_jobs") or 0),
                          heartbeat_age_s=round(float(heartbeat_age)),
                          progress_age_s=round(float(progress_age)),
                          note="Alerta; nao interrompe nem reinicia a sincronizacao")
            elif not stalled and state.get("stalled"):
                self.emit("sync_activity_restored")
            state["stalled"] = stalled
            state.pop("database_observation_failed", None)
        except (RuntimeError, ValueError, IndexError, TypeError, subprocess.TimeoutExpired):
            if not state.get("database_observation_failed"):
                self.emit("database_observation_failed")
            state["database_observation_failed"] = True

        svc = self.runner(["systemctl", "show", SERVICE, "-p", "Result", "--value"], timeout=6)
        failed = svc.returncode == 0 and svc.stdout.strip() not in ("success", "")
        if failed and state.get("service_failure") != svc.stdout.strip():
            self.emit("worker_service_failure", result=svc.stdout.strip())
        elif not failed and state.get("service_failure"):
            self.emit("worker_service_recovered")
        state["service_failure"] = svc.stdout.strip() if failed else None
        self.save(state)

    def elapsed(self, since):
        try:
            earlier = datetime.fromisoformat(since)
            return max(0, round((self.clock() - earlier).total_seconds()))
        except (TypeError, ValueError):
            return None


def main():
    lock_path = Path("/run/lock/odontopix-worker-watchdog.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        Watchdog().run()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("[ODONTOPIX_WORKER_WATCHDOG_FATAL]", type(exc).__name__, str(exc),
              file=sys.stderr, flush=True)
        raise
