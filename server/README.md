# Codex broker (MCP server)

A small, production-quality **stdio MCP server** that lets Claude delegate coding
tasks to **OpenAI's Codex CLI** (`codex`). It solves the timeout problem: long
Codex runs are executed as **detached, fire-and-poll background jobs** so they
never hit MCP/tool timeouts. Job state lives on disk (liveness is checked via
pid), so completed results survive broker restarts; see the background-mode
tradeoff note under "How it works".

Claude asks the broker to run a task; the broker spawns `codex exec` and either
waits (short tasks) or hands back a `job_id` to poll (long tasks).

## What it is

The broker exposes these MCP tools:

| Tool | Purpose |
| --- | --- |
| `codex_task` | Run `codex exec` synchronously, wait, return the final message. Kills the process and returns partial output on timeout. |
| `codex_start` | Spawn a detached `codex exec` in the background; returns a `job_id` immediately. |
| `codex_status` | `running` / `completed` / `failed`, runtime so far, last ~20 lines of output. |
| `codex_result` | Final assistant message + exit status + session id; errors if still running. |
| `codex_cancel` | Kill a job's process tree. |
| `codex_review` | Run `codex exec review` (read-only) against a repo. Optional `focus` text; `background:true` returns a `job_id`. |
| `codex_resume` | Continue a previous Codex session by `session_id` with a new prompt. |

`codex_task` / `codex_result` / `codex_status` surface the Codex **session id**,
which you pass to `codex_resume` to continue a thread.

## Prerequisites

- **Node.js >= 18.18** (developed/tested on Node 22).
- **Codex CLI** installed and logged in:
  ```bash
  npm i -g @openai/codex
  codex login          # ChatGPT login or API key
  codex doctor         # sanity-check the install/auth
  ```
  The `codex` binary must be on your `PATH` (or set `CODEX_BIN` to its absolute path).

## Install

```bash
cd <path-to>/server   # this folder
npm install
```

## Register in the Claude desktop app

Add this to your Claude desktop app MCP config (adjust the absolute path):

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": ["<ABSOLUTE-PATH-TO>/server/server.mjs"]
    }
  }
}
```

The tools then appear to Claude as `codex_task`, `codex_start`, etc.

> **Claude Cowork cloud sessions:** the same tools are surfaced with a prefix,
> e.g. `mcp__remote-devices__Codex_Broker__codex_task`. The tool names and
> parameters are identical — only the namespace differs.

### Optional environment variables

| Var | Effect |
| --- | --- |
| `CODEX_MODEL` | Default model when a call omits `model` (param still wins). |
| `CODEX_BIN` | Absolute path to the real `codex` binary (see resolution below). On Windows this must be `codex.exe`, **not** the `codex.cmd` shim. |
| `CODEX_BROKER_HOME` | Base dir for broker state (default: `~/.codex-broker`). |
| `CODEX_BROKER_JOBS_DIR` | Relocate the jobs dir wholesale (default: `<CODEX_BROKER_HOME>/jobs`). Useful under Windows MSIX virtualization. |

## How it works

Each job gets a directory under `$CODEX_BROKER_HOME/jobs/<job_id>/` containing
`meta.json`, `prompt.txt`, `output.log`, `last-message.txt`, and (when finished)
an `exit` file. There are **two execution modes**:


Both modes spawn `codex` **directly** from the broker process — there is never
an intermediate Node/runner respawn. This matters under a Claude Desktop
**MCPB (Electron) host**: `process.execPath` there is the Claude app binary,
and on some builds (e.g. the Microsoft Store package) the `ELECTRON_RUN_AS_NODE`
fuse is burned, so re-invoking `process.execPath` **always** relaunches the GUI
app — there is no way to get a Node runtime out of it. (Versions up to 1.3.x
used a detached `lib/runner.mjs` for background jobs and died exactly this way
on such hosts; v1.4.0 removed the runner entirely.)

- **Direct (synchronous tools:** `codex_task`, synchronous `codex_review`,
  `codex_resume`**).** Spawn `codex`, wait for it, return the final message.
- **Background (`codex_start`, `codex_review` with `background:true`).** Spawn
  `codex` detached and `unref`'d, return a `job_id` immediately. Exit/error
  handlers **in the broker process** write the `exit` marker, `output.log`
  diagnostics, and `meta.json` updates when codex finishes; status/result are
  always re-derived from disk.

  > **Tradeoff (v1.4.0):** because the completion handlers live in the broker
  > process, a broker (or whole-app) **restart mid-job may orphan or kill an
  > in-flight background job** — its exit status is never recorded, and once
  > the pid is gone `codex_status` reports it as failed with *"process exited
  > without recording status"* (any output codex already wrote to `output.log`
  > and `last-message.txt` remains readable). **Completed-job results still
  > persist on disk** across restarts. Previous versions kept in-flight jobs
  > alive through restarts via the detached runner, but that mechanism cannot
  > work on Electron hosts with the `ELECTRON_RUN_AS_NODE` fuse burned, and a
  > background mode that reliably works beats one that silently can't start.

Common to both modes:

- The prompt is fed to `codex` via **stdin** (the `-` sentinel), and all
  arguments are passed as an **arg array** — never a shell string, and never
  `shell:true` — so arbitrary prompt text can never be interpreted as flags or
  injected into a shell. The stdin stream's `error` event is swallowed so an
  instantly-dead child (EPIPE) can't crash the broker.
- Cancellation / timeout kills the whole process tree: `taskkill /T /F` on
  Windows, a process-group `SIGKILL` elsewhere.
- The final assistant message is read from Codex's `--output-last-message` file
  (format-independent); the session id is parsed from the `--json` JSONL stream,
  with a raw-tail fallback if parsing fails.

## Windows

`npm i -g @openai/codex` on Windows installs a `codex.cmd` / `codex.ps1` **shim**,
not a real executable. Node's `spawn()` refuses to run a `.cmd`/`.ps1` without
`shell: true` (it returns `EINVAL` since the CVE-2024-27980 fix), and this broker
**never uses `shell: true`** (prompts are arbitrary text and must never touch a
shell). So the broker resolves and spawns the real `codex.exe` directly.

**Binary resolution order** (first match wins, cached after first use):

1. **`CODEX_BIN`** — if set, it must point to an existing file, otherwise the
   call fails with a clear error. This always wins.
2. **win32 auto-detect** — search for the vendored executable at
   `…\@openai\codex\node_modules\@openai\codex-win32-*\vendor\*\bin\codex.exe`
   (the `codex-win32-x64` / `codex-win32-arm64` platform dirs are globbed),
   under both:
   - `%APPDATA%\npm\node_modules` (the npm global install), and
   - the `node_modules` sibling of any `PATH` directory that contains a
     `codex.cmd` shim.
3. **fallback** — `codex.exe` on Windows (`codex` elsewhere), resolved via
   `PATH`. If it still can't be spawned, the job fails and its `output.log`
   explains the `ENOENT`/`EINVAL` and tells you to set `CODEX_BIN`.

Find the exact path on the target machine with `codex doctor` (it prints the
vendored binary location, e.g.
`C:\Users\<user>\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`).
If auto-detection misses (non-standard install), set `CODEX_BIN` to that path.

**MCPB extension packaging.** This server can be installed as a Claude Desktop
**MCPB extension**, in which case `CODEX_BIN`, `CODEX_MODEL`,
`CODEX_BROKER_HOME`, and `CODEX_BROKER_JOBS_DIR` can be supplied via the
extension's **user config** (which maps to the server's environment) instead of
a raw `mcpServers` JSON block.

## Security

- **Sandbox policy.** Only two sandbox values are accepted: `read-only` and
  `workspace-write` (default `workspace-write`). Any other value is rejected
  before a process is spawned.
  - `read-only`: Codex may read files and run commands but cannot write to disk.
  - `workspace-write`: Codex may read/write **within the working directory**
    (`cwd`) and run commands in the sandbox; network and writes outside the
    workspace are restricted by Codex's own sandbox.
- **Flags deliberately NOT supported.** The broker will never pass
  `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`,
  or the `danger-full-access` sandbox. These are rejected at build time even if
  requested, so Codex always runs sandboxed with no approval bypass.
- **`cwd` validation.** `cwd` must be an existing absolute directory; otherwise
  the call is rejected.
- `codex_review` always runs read-only (the `review` subcommand takes no sandbox
  flag and does not modify files).
- No shell interpolation anywhere; prompts travel via stdin.

## Troubleshooting

- **`codex doctor`** — first stop for install/auth problems. Run it in a normal
  shell to confirm the CLI is healthy.
- **Login expiry.** ChatGPT logins expire. If jobs suddenly start failing with
  auth errors, run `codex login` again. Check a failed job's `output.log`
  (surfaced in `codex_status` / `codex_result`) for the exact message.
- **Usage-limit / rate-limit errors.** Hitting your ChatGPT plan limits surfaces
  as a **failed job** whose `output.log` shows the rate-limit / usage-limit
  message from Codex. `codex_status` and `codex_result` return that tail so you
  can see it. Wait for the limit to reset or reduce concurrency.
- **`review` needs a git repository.** `codex exec review` reviews changes in a
  repo. Point `cwd` at a git working tree; on a non-repo it will report there is
  nothing to review.
- **Job stuck "running".** Use `codex_cancel({job_id})` to kill its process tree.
- **Where are the logs?** Everything is under `$CODEX_BROKER_HOME/jobs/<job_id>/`
  (default `~/.codex-broker/jobs/`).

## Tests

```bash
npm test          # node test/run-tests.mjs
```

The suite spawns the real server over stdio JSON-RPC and drives it against a
mock `codex` (`test/mock-codex`, placed first on `PATH`) — no network needed. It
covers sync success, sync timeout kill, start→status→result→completion, the
direct-spawn background model (no runner artifacts, broker-recorded exit),
cancel, review, resume, and invalid-sandbox / invalid-cwd rejection.
