# Field-Testing Lessons

Six real defects found and fixed while bringing this system up on a Windows 11 machine with the Microsoft Store build of Claude Desktop, in one debugging session. Recorded because every one of them produces confusing symptoms that would cost the next person hours.

## 1. The extension host is Electron, and `process.execPath` is a trap

**Symptom:** every task failed silently in ~3 seconds; a phantom Claude window flashed on screen each attempt.

**Cause:** inside an MCPB extension, `process.execPath` points at the Claude Desktop executable, not Node. The broker's detached job runner respawned it expecting a Node runtime and got a GUI app instead.

**Fix:** spawn Codex directly (no intermediate runtime respawn) for synchronous work; set `ELECTRON_RUN_AS_NODE=1` and capture a `runner-boot.log` for the background runner. Bonus fix found in the same pass: POSIX negative-pid kills never worked on Windows — use `taskkill /pid <pid> /T /F`.

## 2. npm's `codex` shim is unspawnable on Windows

**Symptom:** `spawn("codex")` fails (ENOENT/EINVAL) even though `codex` works in the user's own terminal.

**Cause:** npm installs a `.cmd`/`.ps1` shim; Node refuses to spawn those without `shell: true`, and shelling out is unacceptable when prompts contain arbitrary text.

**Fix:** resolve the real `codex.exe` from the vendored platform package under the npm global directory; `CODEX_BIN` env override as escape hatch. Same pattern for `gh.exe`, which winget installs to a non-obvious portable path.

## 3. Extension updates don't restart the server

**Symptom:** installed version N+1, version card shows N+1, behavior is still version N. Twice.

**Cause:** the app updates extension metadata without restarting the running server process (and possibly without re-extracting files).

**Fix (procedural):** remove extension → tray-quit → reopen → fresh install. Verify which code is live from behavior or tool schemas, never from the version card.

## 4. The bridge strips parameters named `session_id`

**Symptom:** one tool consistently received an empty required parameter that the caller demonstrably sent; sibling parameters (`job_id`, `prompt`, `cwd`) passed fine.

**Cause:** the desktop bridge treats the name `session_id` as reserved and sanitizes it in transit.

**Fix:** renamed the parameter to `thread_id`. If a tool parameter mysteriously arrives empty, suspect the name before the plumbing.

## 5. The Codex sandbox can't do network, credentials, or `gh` — by design

**Symptom:** `git push` inside a delegation failed with `SEC_E_NO_CREDENTIALS`; even unauthenticated `git ls-remote` failed; `gh.exe` wouldn't launch ("Access is denied").

**Cause:** the sandbox runs as a separate OS user with the Windows credential/TLS subsystem blocked.

**Fix (architectural):** stop fighting it. Codex commits locally; broker-side `git_push`/`git_pull`/`gh_repo_create` tools (unsandboxed, argument-validated, never force) handle all remote operations. Follow-on: files created by the sandbox user trip git's "dubious ownership" check for everyone else — the broker injects a per-invocation `safe.directory` exception via `GIT_CONFIG_*` env vars.

## 6. The bridge caps tool calls at ~60 seconds

**Symptom:** a 67-second task "timed out" at the caller while completing successfully on the machine.

**Cause:** the desktop bridge's per-call ceiling, independent of any timeout parameter the broker accepts.

**Fix (procedural):** synchronous `codex_task` only for sub-45-second jobs; everything else goes background (`codex_start` → poll → `codex_result`). Jobs persist on disk, so a caller-side timeout loses nothing — recover via `codex_status`.

## Meta-lesson

Every fix above was findable because failures left durable artifacts: per-job directories with `output.log`, `command.json`, `meta.json`, and boot logs. Instrument first, then debug. The silent version of any of these failures would have been a wall.
