#!/usr/bin/env python3
"""Resumo somente leitura dos incidentes de disponibilidade do timer."""
import json
from pathlib import Path
from collections import Counter
from datetime import datetime, timedelta, timezone

PATH = Path("/var/log/odontopix/worker-incidents.jsonl")
STATE = Path("/var/lib/odontopix-worker-watchdog/state.json")


def summarize(events):
    counts = Counter(str(e.get("event")) for e in events)
    restored = [e for e in events if e.get("event") in (
        "timer_recovered", "timer_restored_externally")]
    seconds = sum(int(e.get("inactive_seconds") or 0) for e in restored)
    return counts, len(restored), seconds


def main():
    if not PATH.exists():
        print("Ainda nao existem incidentes registrados pelo watchdog.")
        return
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    entries = []
    for line in PATH.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
            timestamp = datetime.fromisoformat(entry["at"])
            if timestamp >= cutoff:
                entries.append(entry)
        except (KeyError, ValueError, TypeError):
            continue
    counts, restored, seconds = summarize(entries)
    print("ODONTOPIX - ultimas 24 horas (eventos observados a cada 60s)")
    print("Paradas detectadas:", counts["timer_inactive"])
    print("Paradas encerradas:", restored)
    print("Tempo total dos intervalos registrados:",
          f"{seconds // 60}min {seconds % 60}s")
    print("Alertas de ausencia de progresso:", counts["sync_without_progress"])
    print("Falhas de worker observadas:", counts["worker_service_failure"])
    try:
        state = json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    if state.get("inactive_since"):
        print("Timer ainda inativo desde:", state["inactive_since"])
    print("Ultimos eventos:")
    for e in entries[-10:]:
        print(e["at"], e["event"], json.dumps(
            {k: v for k, v in e.items() if k not in ("at", "event")},
            ensure_ascii=False))


if __name__ == "__main__":
    main()
