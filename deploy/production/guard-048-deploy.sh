#!/usr/bin/env bash
# Pure decision gate. No Docker/database calls; used by the ordinary deploy.
set -euo pipefail
[[ $# == 2 && "$1" =~ ^[0-9]+$ && "$2" =~ ^[01]$ ]] || { echo "Schema/checkout invalido" >&2; exit 1; }
if [[ "$2" == 1 ]]; then
  if (( 10#$1 < 48 )); then
    echo "[048_TRANSITION_REFUSED] Use o procedimento administrativo 047 -> 048." >&2
    exit 1
  fi
  echo verify-running-image
elif (( 10#$1 >= 48 )); then
  echo "[048_DOWNGRADE_REFUSED] Checkout anterior a 048." >&2
  exit 1
else
  echo ordinary
fi
