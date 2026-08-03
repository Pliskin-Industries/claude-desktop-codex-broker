#!/bin/bash
# SessionStart hook — provision the Codex broker in a hosted container.
#
# A cloud container is ephemeral: server/node_modules, the globally installed
# Codex CLI, and ~/.codex/auth.json are all gone when it is rebuilt. This
# re-establishes them from the environment's secrets on every session start.
#
# Runs only in Claude Code on the web. On a local machine the user installs the
# broker once by hand (see CLAUDE.md), and re-running a global npm install and a
# codex login on every session start would be both slow and rude.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Deliberately NOT `set -e`, and deliberately exiting 0 at the end.
#
# cloud-setup.sh ends with preflight, which exits non-zero whenever Codex cannot
# reach api.openai.com. Until the environment's egress policy allowlists that
# host, a non-zero exit is the CORRECT and expected outcome — it is not a reason
# to fail session startup. The diagnostic output is the deliverable; the exit
# code belongs to whoever runs the script by hand.
bash "$ROOT/scripts/cloud-setup.sh" || true

exit 0
