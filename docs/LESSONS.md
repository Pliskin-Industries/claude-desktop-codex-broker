# Field-Testing Lessons

Eight real defects found and fixed while bringing this system up on a Windows 11 machine with the Microsoft Store build of Claude Desktop. Recorded because every one of them produces confusing symptoms that would cost the next person hours.

## 1. The extension host is Electron, and `process.execPath` is a trap

**Symptom:** every task failed silently in ~3 seconds; a phantom Claude window flashed on screen each attempt.

**Cause:** inside an MCPB extension, `process.execPath` points at the Claude Desktop executable, not Node. The broker's detached job runner respawned it expecting a Node runtime and got a GUI app instead.

**Fix (two stages):** v1.1.1 spawned Codex directly (no intermediate runtime respawn) for synchronous work, and set `ELECTRON_RUN_AS_NODE=1` + captured a `runner-boot.log` for the background runner. Field testing then showed the Microsoft Store build **ignores `ELECTRON_RUN_AS_NODE` entirely** (the Electron fuse is burned), so background jobs still launched a phantom GUI and died "without recording status" with an empty `output.log`. v1.4.0 therefore removed the runner altogether: background jobs also spawn `codex.exe` directly (detached + unref'd, exit recorded by broker-side handlers). Tradeoff: a broker restart mid-job may orphan an in-flight background job; completed results still persist on disk. Bonus fix found in the same pass: POSIX negative-pid kills never worked on Windows — use `taskkill /pid <pid> /T /F`.

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

## 7. `detached: true` on Windows = a console-window storm from the child's children

**Symptom:** v1.4.0 background jobs completed correctly (exit 0, files written), but many console windows flashed on screen while the job ran — one per command Codex executed.

**Cause:** the background path spawned `codex.exe` with `detached: true`, which on Windows means `DETACHED_PROCESS` — the child gets *no console at all*. `windowsHide` hides only codex's own (nonexistent) window; every console child codex then spawns (powershell.exe per command execution) has no parent console to attach to, so Windows allocates a fresh **visible** console for each. The sync path never flashed because it already used `detached: !IS_WINDOWS` — `windowsHide` alone gives codex a `CREATE_NO_WINDOW` hidden console that its children inherit silently. This class of bug is invisible to any Linux/macOS CI; only a human watching a Windows screen catches it.

**Fix (v1.4.1):** background spawn uses `detached: !IS_WINDOWS`, exactly like the sync path. Nothing is lost on Windows: `unref()` works without `detached`, and tree-kill already goes through `taskkill /T`. POSIX keeps `detached: true` for process-group kills via `-pid`.

## 8. Codex cannot commit in an existing repo — the sandbox write-protects `.git`

**Symptom:** a delegation asked Codex to `git add -A && git commit`; the working-tree file copies succeeded, but every git write failed with `fatal: Unable to create '.git/index.lock': Permission denied`, with no pre-existing lock file.

**Cause:** Codex CLI's workspace-write sandbox deny-ACLs the repo's `.git` directory for the sandbox user at session start (visible via `Get-Acl .git`: Deny Write/Delete ACEs for the sandbox user's SID, which take precedence over its Allow entries). Working-tree writes are permitted; history writes are not. The "Codex commits locally, broker pushes" loop assumed `.git` was writable — on current Codex builds it is not.

**Fix (procedural, verified):** a `.git` created *by* the session is not protected. Have Codex `git clone --no-hardlinks` the repo into its temp directory, commit there, point `origin` at the GitHub URL, and call broker `git_push` with the temp clone's path as `cwd`. Sync the user's primary clone afterward (`git pull --ff-only`, or `git reset --hard origin/<branch>` if its tree was left dirty). Longer-term fix: a broker-side `git_commit` tool so commits, like pushes, happen outside the sandbox.

## 9. A sleeping laptop looks like a DNS outage from inside Codex

**Symptom:** long background jobs died or ran for hours with repeated `ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: No such host is known. (os error 11001)` storms (`Reconnecting... n/5`, then `Falling back from WebSockets to HTTPS transport`, then the HTTPS retries failing too). Shell checks taken later showed DNS resolving in milliseconds and TLS connecting, so the blackouts were blamed on the Codex CLI's transport or on flaky local DNS. Three jobs, ~7.5 hours of wall-clock, one usable result.

**Cause:** the laptop was entering Modern Standby (Windows event `Kernel-Power` 506, reasons Idle Timeout on battery, Lid, and a battery-budget policy). Standby on this class of machine is "network disconnected by policy", so the Wi-Fi drops (`WLAN-AutoConfig` 8003) and every user process is suspended. On wake, Codex's pending request resumes a few hundred milliseconds before the adapter has re-associated, the resolver has no server to ask, and Winsock returns 11001. Every error burst in the three job logs lands within two seconds of a 507 (standby exit) event. The "six hour" job was suspended for four and a half of them. Nothing about the transport, the router's resolver, or a public DNS pin could have changed that.

**Fix (v1.6.0):** three layers. (1) The broker passes `-c features.prevent_idle_sleep=true` on every codex spawn, and `scripts/configure-codex.mjs` writes it into `~/.codex/config.toml` during setup, so idle sleep is inhibited while a turn runs (lid close and battery policies still win: keep the machine on AC with the lid open for long jobs). (2) `codex_status` now reports seconds since the job's output last grew and warns past a threshold; `max_idle_seconds` on `codex_start` / background `codex_review` has the broker kill a job that goes silent instead of leaving it for hours. (3) Optional HTTPS-only provider (`--https-only` in the config script, or `CODEX_BROKER_TRANSPORT=https`) removes the WebSocket retry storm that made the logs look like a transport bug — verified on codex-cli 0.145.0: a custom `[model_providers.*]` with `supports_websockets = false` and `requires_openai_auth = true` is honored even though the `responses_websockets` feature flag reads "removed".

**Diagnostic rule:** an error that names the resolver (11001) is not evidence about the resolver until you have correlated the timestamps with the power and WLAN event logs. Read the job's `output.log` first; it is always there (under the `CODEX_BROKER_HOME` the registration set, which may not be `~/.codex-broker`).

## Meta-lesson

Every fix above was findable because failures left durable artifacts: per-job directories with `output.log`, `command.json`, `meta.json`, and boot logs. Instrument first, then debug. The silent version of any of these failures would have been a wall. Lesson 9 adds the corollary: the artifacts have to be *read*. Three job logs and the Windows event log held the whole answer while an escalation blamed DNS on the strength of a shell check taken at a different minute.
