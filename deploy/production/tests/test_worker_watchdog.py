"""Regressoes do watchdog; sem Docker, systemd ou PostgreSQL reais."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "worker-watchdog.py"
spec = importlib.util.spec_from_file_location("worker_watchdog", SCRIPT)
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)


class FakeCommands:
    def __init__(self):
        self.enabled = True
        self.active = False
        self.app_running = True
        self.service_result = "success"
        self.metrics = {"active_syncs": 1, "active_jobs": 1,
                        "heartbeat_age_s": 12, "last_progress_age_s": 10}
        self.starts = 0

    def __call__(self, args, *, input=None, timeout=15):
        if args[:2] == ["systemctl", "is-enabled"]:
            return self.done(args, "enabled" if self.enabled else "disabled",
                             0 if self.enabled else 1)
        if args[:2] == ["systemctl", "is-active"]:
            return self.done(args, "active" if self.active else "inactive",
                             0 if self.active else 3)
        if args[:2] == ["systemctl", "start"]:
            self.active = True
            self.starts += 1
            return self.done(args, "")
        if args[:2] == ["systemctl", "show"]:
            return self.done(args, self.service_result)
        if args[:2] == ["docker", "inspect"]:
            return self.done(args, "true" if self.app_running else "false")
        if args[:2] == ["docker", "exec"]:
            return self.done(args, json.dumps(self.metrics))
        raise AssertionError(f"Chamada inesperada: {args}")

    @staticmethod
    def done(args, stdout, code=0):
        return subprocess.CompletedProcess(args, code, stdout + "\n", "")


class WorkerWatchdogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.fake = FakeCommands()
        self.current = datetime(2026, 11, 9, 17, 0, tzinfo=timezone.utc)
        self.healthy = True
        self.mon = watchdog.Watchdog(
            runner=self.fake,
            health=lambda: self.healthy,
            clock=lambda: self.current,
            state_path=self.base / "state.json",
            event_path=self.base / "events.jsonl",
            maintenance=self.base / "maintenance"
        )

    def events(self):
        return [json.loads(line) for line in
                (self.base / "events.jsonl").read_text().splitlines()]

    def test_restaura_timer_habilitado_com_app_saudavel(self):
        self.mon.run()
        self.assertTrue(self.fake.active)
        self.assertEqual(self.fake.starts, 1)
        codes = [item["event"] for item in self.events()]
        self.assertIn("timer_inactive", codes)
        self.assertIn("timer_recovered", codes)

    def test_nao_restaura_durante_manutencao(self):
        (self.base / "maintenance").mkdir()
        self.mon.run()
        self.assertFalse(self.fake.active)
        self.assertEqual(self.fake.starts, 0)
        self.assertEqual(self.events()[-1]["reason"], "maintenance_guard")

    def test_nao_restaura_timer_desabilitado_intencionalmente(self):
        self.fake.enabled = False
        self.mon.run()
        self.assertEqual(self.fake.starts, 0)
        self.assertEqual(self.events()[-1]["reason"], "timer_disabled_intentionally")

    def test_nao_restaura_app_indisponivel(self):
        self.healthy = False
        self.mon.run()
        self.assertEqual(self.fake.starts, 0)
        self.assertEqual(self.events()[-1]["reason"], "application_unhealthy")

    def test_nao_restaura_container_parado(self):
        self.fake.app_running = False
        self.mon.run()
        self.assertEqual(self.fake.starts, 0)
        self.assertEqual(self.events()[-1]["reason"], "application_container_not_running")

    def test_alerta_sem_progresso_sem_reiniciar(self):
        self.fake.active = True
        self.fake.metrics = {
            "active_syncs": 1, "active_jobs": 1,
            "heartbeat_age_s": 600, "last_progress_age_s": 550
        }
        self.mon.run()
        self.mon.run()
        self.assertEqual(self.fake.starts, 0)
        self.assertEqual(
            len([e for e in self.events() if e["event"] == "sync_without_progress"]), 1
        )
        self.fake.metrics["heartbeat_age_s"] = 20
        self.mon.run()
        self.assertEqual(self.events()[-1]["event"], "sync_activity_restored")

    def test_registra_duracao_da_parada_externa(self):
        (self.base / "maintenance").mkdir()
        self.mon.run()
        self.fake.active = True
        self.current += timedelta(minutes=9)
        self.mon.run()
        self.assertEqual(self.events()[-1]["inactive_seconds"], 540)
        self.assertEqual(self.events()[-1]["event"], "timer_restored_externally")


if __name__ == "__main__":
    unittest.main()
