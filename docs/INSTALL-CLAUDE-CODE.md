# Installing the Codex Broker for Claude Code

Two paths. The first is the point of this repo: let Claude Code do its own
setup.

## Path A — let Claude Code set itself up (recommended)

```bash
git clone https://github.com/GhengisPliskin/claude-desktop-codex-broker.git
cd claude-desktop-codex-broker
claude
```

Then tell Claude Code:

> Set up the Codex broker per CLAUDE.md.

Claude Code reads `CLAUDE.md`, checks prerequisites (Node ≥ 18.18, Codex CLI,
git), runs `npm ci --prefix server`, installs the `codex-delegation` skill to
`~/.claude/skills/`, runs the 41-test suite, and walks you through the one step
it cannot do for you: `codex login` (interactive, bills to your ChatGPT plan or
API key).

The repo ships a project-scoped `.mcp.json`, so when you open Claude Code
inside this repo it will ask to enable the `codex-broker` server — approve it
and the fifteen `mcp__codex-broker__*` tools appear. To use the broker from *any*
directory, ask Claude Code to register it user-scoped:

```bash
claude mcp add --scope user codex-broker -- node /absolute/path/to/claude-desktop-codex-broker/server/server.mjs
```

## Path B — manual

1. Prerequisites: Node ≥ 18.18, `npm install -g @openai/codex` + `codex login`,
   git; optionally GitHub CLI (`gh auth login`) for `gh_repo_create`.
2. `npm ci --prefix server` from the repo root.
3. Register the server (project scope comes free via `.mcp.json`; user scope
   via the `claude mcp add` command above).
4. Copy `skill/` to `~/.claude/skills/codex-delegation/`.
5. Verify: `cd server && node test/run-tests.mjs` → 41/41. Restart Claude Code,
   confirm the tools are listed, then run a `codex_task` smoke test
   ("Reply with exactly: READY").

## Notes

- **Windows binary resolution.** The broker resolves the real vendored
  `codex.exe` automatically (the npm `codex.cmd` shim is unspawnable from
  Node). If resolution fails, set `CODEX_BIN` to the path `codex doctor`
  reports. Same idea for `GH_BIN` / `GIT_BIN`.
- **Timeouts.** Claude Desktop's bridge caps tool calls at ~60s, which is why
  the skill mandates background jobs for real work. Claude Code's MCP timeout
  is configurable and typically higher, but the background-first rule stands —
  job state persists in `~/.codex-broker/jobs/` and survives caller timeouts.
- **Security model.** Codex runs sandboxed (`workspace-write` max, no network,
  no credentials, cannot write the repo's `.git`); remote git goes through
  broker-side tools that validate arguments and never force-push. See
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Claude Desktop / Cowork install** (the .mcpb route): see
  [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).
- **Something broken?** [LESSONS.md](LESSONS.md) — ten field-verified failure
  modes with symptoms, causes, and fixes.
