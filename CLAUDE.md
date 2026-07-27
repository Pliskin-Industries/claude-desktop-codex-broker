# Codex Broker — agent guide

This repo is an MCP server ("the broker") that lets Claude delegate scoped
coding work to OpenAI's Codex CLI, plus a `codex-delegation` skill that defines
the working protocol. Claude plans, reviews, and integrates; Codex implements
inside an OS-level sandbox; the broker (unsandboxed) handles spawning, job
state, and credentialed git operations.

If the user asks you to "set this up", "install the broker", or points you at
this repo to make Codex delegation work in Claude Code, follow the setup
sequence below in order. Report each step's outcome; stop and surface any
failure rather than improvising around it.

## Setup sequence for Claude Code

1. **Check prerequisites.** All three must pass before anything else:
   - `node --version` → must be >= 18.18.
   - `codex --version` → Codex CLI present. If missing:
     `npm install -g @openai/codex`, then the USER must run `codex login`
     themselves (interactive; uses their ChatGPT plan or API key). Do not
     attempt to log in for them.
   - `git --version` → required. `gh --version` is optional (only needed for
     `gh_repo_create`); if missing, note it and continue.

2. **Install server dependencies.** From the repo root:
   `npm ci --prefix server`
   The tracked source has no `node_modules`; the MCP server will not start
   without this step. Never commit `node_modules`.

3. **MCP registration.** The repo root's `.mcp.json` already defines the
   project-scoped server (`node server/server.mjs`, cwd = repo root), so
   sessions opened inside this repo get the tools after the user approves the
   project server. For use from ANY directory, register user-scoped instead:
   `claude mcp add --scope user codex-broker -- node <ABSOLUTE-PATH-TO-REPO>/server/server.mjs`
   (use the real absolute path; on Windows use backslashes and quote it).

4. **Install the skill.** Copy the `skill/` directory to the user's skills
   folder as `codex-delegation`:
   - macOS/Linux: `mkdir -p ~/.claude/skills && cp -r skill ~/.claude/skills/codex-delegation`
   - Windows (PowerShell): `Copy-Item -Recurse skill "$env:USERPROFILE\.claude\skills\codex-delegation"`
   If a copy already exists, replace it — the skill and broker version together.

5. **Verify.**
   - `node server/test/run-tests.mjs` (from `server/`) → expect 24/24 pass. The
     suite uses a mock codex on PATH; no network or OpenAI account needed.
   - Restart the Claude Code session so MCP servers reload. Tools appear as
     `mcp__codex-broker__<name>` (project scope) — fifteen tools: codex_task,
     codex_start, codex_status, codex_result, codex_cancel, codex_review,
     codex_resume, git_push, git_pull, git_commit, git_clone, gh_repo_create,
     gh_read, gh_pr_create, gh_issue_create.
   - Smoke test: `codex_task` with prompt "Reply with exactly: READY" and
     `cwd` set to any existing directory. Expect READY. This confirms the
     real Codex CLI resolves and authenticates.
   - If the spawn fails on Windows with ENOENT/EINVAL, the npm `codex.cmd`
     shim was found instead of the real binary — set the `CODEX_BIN` env var
     to the vendored `codex.exe` path (see docs/LESSONS.md #2).

## Things to know before working in this repo

- **Read `skill/SKILL.md` before delegating anything to Codex.** It is the
  operating protocol: role split, task scoping, git sync, failure handling.
  Non-negotiables: background jobs (`codex_start`) are the default for real
  work; every delegation prompt carries acceptance criteria, files-in-scope, a
  do-not-touch list, and a test mandate; Codex output is a proposal you review,
  never an auto-merge.
- **Codex cannot commit in an existing clone** — its sandbox write-protects
  the repo's `.git` (docs/LESSONS.md #8). The working pattern is in
  `skill/references/git-protocol.md`: Codex clones into its own temp dir,
  commits there, and the broker pushes from that clone path.
- **Sandbox is capped at `workspace-write`.** The broker rejects escalation
  flags by construction. Do not try to widen it; ask the user instead.
- **Host differences.** Under Claude Desktop/Cowork the tools arrive through
  the device bridge as `mcp__remote-devices__Codex_Broker__<name>` and every
  tool call is capped at ~60s (hence the sub-45s rule for sync `codex_task`).
  In Claude Code the MCP timeout is configurable and typically higher, but
  keep background as the default for real work anyway — job state persists on
  disk (`~/.codex-broker/jobs/`) and survives caller timeouts.
- **Tests are the merge gate.** `node server/test/run-tests.mjs` must stay
  24/24 (or grow). The suite runs the server over real stdio JSON-RPC with a
  mock codex binary; add tests the same way.
- **`dist/` is built, not source.** `codex-broker.mcpb` = zip of
  `manifest.json` + `package.json` + `node_modules/` + `server/` (no dir
  entries). `codex-delegation.skill` = zip of `codex-delegation/` wrapping
  `skill/`'s contents. Rebuild both when their inputs change; keep manifest,
  `server/package.json`, and `server.mjs` versions in lockstep.
- **docs/LESSONS.md is the debugging map.** Eight field-verified failure modes
  with symptoms and fixes. Check it before diagnosing anything Windows- or
  Desktop-host-related.
