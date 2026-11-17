#!/usr/bin/env python3
"""Summarize opt-in Visao Analitica performance events from application logs.

Read from stdin; no network, database access, or personal data required.
Example:
  docker logs --since 20m odontopix-app-1 2>&1 |
    python3 /opt/odontopix/app/scripts/summarize-analytics-performance.py
"""
import json
import math
import sys
from collections import defaultdict

PREFIX = "[ANALYTICS_PERF] "
events = defaultdict(list)
traces = set()
max_waiting = 0
error_count = 0

for line in sys.stdin:
    if PREFIX not in line:
        continue
    try:
        event = json.loads(line.split(PREFIX, 1)[1].strip())
        tab = str(event["tab"])
        stage = str(event["stage"])
        elapsed = float(event["elapsedMs"])
        waiting = int(event.get("poolWaiting", 0))
        if not math.isfinite(elapsed) or elapsed < 0:
            continue
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        continue
    events[(tab, stage)].append(elapsed)
    max_waiting = max(max_waiting, waiting)
    if event.get("outcome") == "error":
        error_count += 1
    if stage == "request_data_total" and event.get("outcome") == "ok":
        traces.add(event.get("traceId"))

if not events:
    print("Nenhuma medicao encontrada. Verifique ANALYTICS_PERF_ENABLED e os logs do app.")
    sys.exit(0)

print(f"Requisicoes completas medidas: {len(traces)}")
print(f"Maior espera no pool (conexoes): {max_waiting}")
print(f"Etapas com erro: {error_count}")
print()
print(f"{'Aba':<15} {'Etapa':<25} {'N':>5} {'P50(ms)':>10} {'P95(ms)':>10} {'Max(ms)':>10}")
print("-" * 85)
for (tab, stage), values in sorted(events.items()):
    samples = sorted(values)
    n = len(samples)
    median = (samples[(n - 1) // 2] + samples[n // 2]) / 2
    p95 = samples[max(0, math.ceil(0.95 * n) - 1)]
    print(f"{tab:<15.15} {stage:<25.25} {n:>5} {median:>10.1f} {p95:>10.1f} {samples[-1]:>10.1f}")

print()
print("P50/P95 refletem somente os registros recebidos; nao incluem rede nem renderizacao no navegador.")
