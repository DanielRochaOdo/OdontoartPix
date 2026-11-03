#!/usr/bin/env bash
set -euo pipefail

# Execute in a developer checkout, not on the production VPS.
cd "$(dirname "$0")/.."

# The official installer writes the Codex project skill and its design hook.
# It does not add an application runtime dependency.
npx --yes impeccable install --providers=codex --scope=project

echo "Impeccable configured for Codex. Review generated files and commit the .agents/ and .codex/ project artifacts."
echo "Reload Codex, approve the project hook via /hooks, then run \$impeccable init."
