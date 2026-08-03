#!/usr/bin/env bash
# Build dist/codex-delegation.skill — the uploadable Claude skill package.
#
# Layout: a single codex-delegation/ folder wrapping the contents of skill/:
#   codex-delegation/SKILL.md
#   codex-delegation/references/git-protocol.md
#   codex-delegation/references/gpt-prompting.md
#
# Unlike the .mcpb, this archive DOES carry directory entries — the shipped
# 1.5.0 artifact has two (codex-delegation/ and codex-delegation/references/).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/codex-delegation.skill"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

command -v zip >/dev/null 2>&1 || { echo "error: 'zip' is required but not installed." >&2; exit 1; }

mkdir -p "$STAGE/codex-delegation"
cp -R "$ROOT/skill/." "$STAGE/codex-delegation/"

mkdir -p "$ROOT/dist"
rm -f "$OUT"
( cd "$STAGE" && zip -r -X -q "$OUT" codex-delegation )

echo "built $OUT"
echo "  entries: $(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
unzip -l "$OUT" | awk '{print "    " $4}' | grep -E "codex-delegation" || true
