#!/usr/bin/env bash
# Provision the Codex broker in a cloud / headless container.
#
# Idempotent: safe to run on every session start. A hosted container is
# ephemeral, so everything this does (dependencies, the Codex CLI, and the
# Codex login) has to be redone each time the container is rebuilt. The
# credential itself is NOT stored here — it comes from an environment secret you
# set once in the environment's configuration.
#
# Auth precedence:
#   CODEX_ACCESS_TOKEN  -> reuses an existing ChatGPT plan (no per-token billing)
#   OPENAI_API_KEY      -> OpenAI API billing, separate from a ChatGPT subscription
#
# Secret VALUES are never printed, echoed, or written to disk by this script;
# they are piped to the Codex CLI on stdin and only the method name is reported.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

step "Node"
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed. Node >= 18.18 is required." >&2
  exit 1
fi
say "$(node --version)"

step "Server dependencies"
if [ -d server/node_modules ]; then
  say "already installed (server/node_modules present)"
else
  npm ci --prefix server >/dev/null 2>&1 && say "installed via npm ci" || {
    echo "error: npm ci --prefix server failed. Run it manually to see why." >&2
    exit 1
  }
fi

step "Codex CLI"
if command -v codex >/dev/null 2>&1; then
  say "already installed: $(codex --version 2>/dev/null || echo 'version unknown')"
else
  say "installing @openai/codex ..."
  if npm install -g @openai/codex >/dev/null 2>&1; then
    say "installed: $(codex --version 2>/dev/null || echo 'version unknown')"
  else
    echo "error: npm install -g @openai/codex failed." >&2
    echo "       If the npm registry is blocked by egress policy, report that host." >&2
    exit 1
  fi
fi

step "Sandbox backend"
if command -v bubblewrap >/dev/null 2>&1 || command -v bwrap >/dev/null 2>&1; then
  say "bubblewrap present"
else
  # Codex ships its own bubblewrap and falls back to it with a warning, so this
  # is an optimization, not a requirement. Never fail the run over it.
  if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    say "installing bubblewrap ..."
    apt-get install -y -qq bubblewrap >/dev/null 2>&1 \
      && say "installed" \
      || say "install failed — Codex will use its bundled bubblewrap (fine)"
  else
    say "not present — Codex will use its bundled bubblewrap (fine)"
  fi
fi

step "Codex authentication"
if codex login status >/dev/null 2>&1 && ! codex login status 2>&1 | grep -qi "not logged in"; then
  say "already authenticated"
elif [ -n "${CODEX_ACCESS_TOKEN:-}" ]; then
  printf '%s' "$CODEX_ACCESS_TOKEN" | codex login --with-access-token >/dev/null 2>&1 \
    && say "authenticated via CODEX_ACCESS_TOKEN (ChatGPT plan)" \
    || { echo "error: codex login --with-access-token failed (token rejected or malformed)." >&2; exit 1; }
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1 \
    && say "authenticated via OPENAI_API_KEY (OpenAI API billing)" \
    || { echo "error: codex login --with-api-key failed (key rejected or malformed)." >&2; exit 1; }
else
  say "no credential found in the environment."
  say "Set ONE of these as a secret in the environment's configuration:"
  say "  CODEX_ACCESS_TOKEN  - reuses your ChatGPT plan"
  say "  OPENAI_API_KEY      - OpenAI API billing (separate from ChatGPT)"
  say "Interactive 'codex login' cannot work here: it needs a browser."
fi

step "Preflight"
# Preflight owns the pass/fail verdict, including the egress check. Let its exit
# status be this script's exit status.
exec node "$ROOT/scripts/preflight.mjs"
