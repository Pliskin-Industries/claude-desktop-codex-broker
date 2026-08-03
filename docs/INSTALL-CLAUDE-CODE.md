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
`~/.claude/skills/`, runs the test suite, and walks you through the one step
it cannot do for you: `codex login` (interactive, bills to your ChatGPT plan or
API key).

The repo ships a project-scoped `.mcp.json`, so when you open Claude Code
inside this repo it will ask to enable the `codex-broker` server — approve it
and the fifteen `mcp__codex-broker__*` tools appear. To use the broker from *any*
directory, ask Claude Code to register it user-scoped:

```bash
claude mcp add --scope user codex-broker -- node "$(git rev-parse --show-toplevel)/server/server.mjs"
```

A literal absolute path also works when registering from outside the clone.

## Path B — manual

1. Prerequisites: Node ≥ 18.18, `npm install -g @openai/codex` + `codex login`,
   git; optionally GitHub CLI (`gh auth login`) for `gh_repo_create`.
2. `npm ci --prefix server` from the repo root.
3. Register the server (project scope comes free via `.mcp.json`; user scope
   via the `claude mcp add` command above).
4. Copy `skill/` to `~/.claude/skills/codex-delegation/`.
5. Verify: `cd server && node test/run-tests.mjs` → `0 failed`. Restart Claude Code,
   confirm the tools are listed, then run a `codex_task` smoke test
   ("Reply with exactly: READY").

## Path C — you already run the broker in Claude Desktop / Cowork

If the `.mcpb` extension can complete a real `codex_task` in chat, the
Desktop-hosted broker can spawn an authenticated Codex CLI. Check `gh auth
status` separately if you want to use the `gh_*` tools. Claude Code does **not**
inherit the Desktop MCP registration — the extension and the CLI are separate
MCP hosts, so Claude Code needs its own registration. What's left is three
steps.

1. **Get the source on disk with its dependencies.** The extension bundles its
   own `node_modules`, but its install directory is opaque and gets replaced on
   every extension update — don't point Claude Code at it. Use a normal clone:

   ```powershell
   git clone https://github.com/GhengisPliskin/claude-desktop-codex-broker.git
   cd claude-desktop-codex-broker
   npm ci --prefix server
   ```

2. **Register the server user-scoped** so the tools are available in every
   Claude Code session, not just ones opened inside this repo:

   ```powershell
   $serverPath = (Resolve-Path -LiteralPath .\server\server.mjs).Path
   claude mcp add --scope user codex-broker -- node $serverPath
   ```

   A literal absolute path also works when registering from outside the clone.
   Project scope via the repo's `.mcp.json` also works, but only inside the repo.

3. **Install the skill locally.** Claude Code reads `~/.claude/skills/`; a skill
   uploaded to your Claude *account* is a different copy and may be older.

   ```powershell
   Copy-Item -Recurse -Force skill "$env:USERPROFILE\.claude\skills\codex-delegation"
   ```

Then restart Claude Code and confirm the fifteen `mcp__codex-broker__*` tools
are listed. Tool names differ by host: a Desktop extension uses
`mcp__Codex_Broker__codex_start`, Cowork uses
`mcp__remote-devices__Codex_Broker__codex_start`, and Claude Code CLI uses
`mcp__codex-broker__codex_start`. The skill therefore refers to tools by bare
name.

Running both hosts side by side is fine; they are independent server processes.
They do *not* reliably share job state, though: job directories live under
`~/.codex-broker/jobs/`, and the Microsoft Store build of Claude Desktop runs
under MSIX virtualization, which can redirect that home path. Poll a job from
the host that started it, or set `CODEX_BROKER_JOBS_DIR` to the same explicit
absolute path in both.

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
- **Something broken?** [LESSONS.md](LESSONS.md) — eight field-verified failure
  modes with symptoms, causes, and fixes.
