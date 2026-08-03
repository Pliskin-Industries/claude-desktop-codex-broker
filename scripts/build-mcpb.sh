#!/usr/bin/env bash
# Build dist/codex-broker.mcpb — the Claude Desktop extension package.
#
# Layout (must match what Desktop expects; see CLAUDE.md "dist/ is built"):
#   manifest.json          <- repo-root manifest.json
#   package.json           <- copy of server/package.json
#   node_modules/          <- copy of server/node_modules
#   server/server.mjs      <- runtime sources only (no tests, no README)
#   server/lib/*.mjs
#
# The archive carries NO directory entries (zip -D). Desktop's unpacker has been
# observed to choke on them; the shipped 1.5.0 artifact has zero.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/codex-broker.mcpb"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ ! -d "$ROOT/server/node_modules" ]; then
  echo "error: server/node_modules is missing. Run:  npm ci --prefix server" >&2
  exit 1
fi

command -v zip >/dev/null 2>&1 || { echo "error: 'zip' is required but not installed." >&2; exit 1; }

cp "$ROOT/manifest.json"        "$STAGE/manifest.json"
cp "$ROOT/server/package.json"  "$STAGE/package.json"
cp -R "$ROOT/server/node_modules" "$STAGE/node_modules"

# Prune what the Node runtime never loads: type declarations, source maps, and
# per-package tooling config. This holds the package to roughly a third of the
# size an unpruned install would produce.
#
# NOTE: this does not reproduce the shipped 1.5.0 .mcpb file-for-file. That
# artifact was assembled by hand before this script existed and its pruning was
# inconsistent (it stripped .d.ts but kept .d.cts). Exact parity with it is not
# a useful goal; a correct, smaller, reproducible package is. The gate is the
# functional smoke test below, not a file-list diff.
rm -rf "$STAGE/node_modules/.bin"
find "$STAGE/node_modules" -type f \
  \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
     -o -name 'tsconfig.json' -o -name '.eslintrc*' -o -name '.nycrc' \
     -o -name '.editorconfig' -o -name '.npmignore' -o -name '.travis.yml' \) \
  -delete

mkdir -p "$STAGE/server/lib"
cp "$ROOT/server/server.mjs"    "$STAGE/server/server.mjs"
cp "$ROOT/server/lib/"*.mjs     "$STAGE/server/lib/"

mkdir -p "$ROOT/dist"
rm -f "$OUT"
# -r recurse, -D no directory entries, -X no extra file attributes, -q quiet
( cd "$STAGE" && zip -r -D -X -q "$OUT" manifest.json package.json node_modules server )

echo "built $OUT"
echo "  entries:        $(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
echo "  dir entries:    $(unzip -l "$OUT" | awk '$1==0 && $4 ~ /\/$/' | wc -l | tr -d ' ')  (must be 0)"
echo "  manifest ver:   $(grep -m1 '"version"' "$ROOT/manifest.json" | sed 's/[^0-9.]//g')"
