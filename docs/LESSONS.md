# Field-Testing Lessons

Ten real defects found and fixed while bringing this system up — lessons 1–8 on a Windows 11 machine with the Microsoft Store build of Claude Desktop, lessons 9–10 in a Claude Code on the web container. Recorded because every one of them produces confusing symptoms that would cost the next person hours.

Lessons 1, 2, 3, 4, 6 and 7 are artifacts of the Windows/Desktop host and do not arise in a Linux container. Lessons 5 and 8 are Codex sandbox capability boundaries; whether 8 reproduces on Linux has not been verified.

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

## 9. In a hosted container, the proxy — not the broker — is usually what failed

**Symptom:** Codex delegation fails in Claude Code on the web. The log shows a burst of `ERROR: Reconnecting... n/5` against `wss://api.openai.com/v1/responses`, then `stream disconnected before completion`. Everything about the install looks correct: the CLI is present, `codex login status` says logged in, the sandbox initializes.

**Cause:** two independent things, easily confused with each other and with a broker bug.

First, hosted sessions route outbound HTTPS through a policy-enforcing proxy. If `api.openai.com` is not on the environment's allowlist, the proxy refuses the CONNECT with `HTTP CONNECT failed with status 403`. This is an organization policy decision. It is not a misconfiguration, retrying does not help, and routing around it is not an acceptable fix.

Second, Codex 0.146 *prefers* a WebSocket transport, and WebSocket upgrades are not supported through such proxies. Codex retries five times, gives up, and falls back to HTTPS — which works. So on a correctly allowlisted environment you will still see a wall of red `Reconnecting` errors before the run succeeds. That output looks like a hard failure and is not one.

**Fix:** run `node scripts/preflight.mjs`, which classifies the failure rather than echoing a raw error — separating a policy denial from a TLS trust problem, a plain-HTTP-to-proxy mistake, and simple unreachability, and naming the exact host to allowlist. Treat the `Reconnecting` burst as noise if the run completes.

## 10. Cloud containers are ephemeral, so authentication is a per-session step

**Symptom:** Codex worked at the end of one hosted session and is "not logged in" at the start of the next, with nothing having changed.

**Cause:** the container is rebuilt between sessions. `~/.codex/auth.json`, the globally installed Codex CLI, and `server/node_modules` do not survive. Nothing is corrupted; the machine is simply new.

**Fix:** keep the credential in the *environment's* secret configuration rather than in the container, and re-authenticate on every session start from that secret. `scripts/cloud-setup.sh` does this non-interactively — `codex login --with-access-token` or `--with-api-key`, both reading from stdin — and `.claude/hooks/session-start.sh` runs it automatically. Interactive `codex login` is not an option: it needs a browser. Prefer `CODEX_ACCESS_TOKEN`, which reuses an existing ChatGPT plan, over `OPENAI_API_KEY`, which bills separately per token.

## Meta-lesson

Every fix above was findable because failures left durable artifacts: per-job directories with `output.log`, `command.json`, `meta.json`, and boot logs. Instrument first, then debug. The silent version of any of these failures would have been a wall.
