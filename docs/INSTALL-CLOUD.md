# Cloud / headless install (Claude Code on the web)

Running the broker in a hosted container rather than on your own machine. Written
for Claude Code on the web; the steps work in any Linux container with the same
two prerequisites.

This path differs from a local install in three ways that drive everything below:

| | Local (Desktop / Claude Code) | Cloud container |
|---|---|---|
| Codex location | Your machine, alongside your repos | The same container as Claude |
| Authentication | Interactive `codex login` in a browser | Non-interactive, from an environment secret |
| Persistence | Permanent | Ephemeral — rebuilt between sessions |

## Prerequisites you must set up yourself

Neither of these can be automated from inside the container. Both are settings on
the environment.

### 1. Allow egress to `api.openai.com`

Hosted sessions route outbound HTTPS through a policy-enforcing proxy. If
`api.openai.com` is not on the allowlist, every Codex call fails like this:

```
ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket:
  URL error: Proxy connection failed: HTTP CONNECT failed with status 403
```

That 403 is an **organization egress policy denial**, not a broken install. It
cannot be fixed from inside the container, and it must not be worked around —
report the blocked host and have it allowlisted in the environment's network
policy. See the [Claude Code on the web docs](https://code.claude.com/docs/en/claude-code-on-the-web)
for how network policies are configured.

Run `node scripts/preflight.mjs` to confirm which failure you have.

### 2. Provide a credential as an environment secret

Interactive `codex login` opens a browser and therefore cannot work headless. Set
**one** of these as a secret in the environment's configuration:

| Secret | Billing | Notes |
|---|---|---|
| `CODEX_ACCESS_TOKEN` | Your existing ChatGPT plan | Preferred if you already pay for ChatGPT. Extract the token from a machine where you have run `codex login`. |
| `OPENAI_API_KEY` | OpenAI API, **billed separately** | Pay-per-token. Does not draw on a ChatGPT subscription. |

`scripts/cloud-setup.sh` prefers `CODEX_ACCESS_TOKEN` when both are present, so
you are not silently moved onto API billing. Secret *values* are piped to the
Codex CLI on stdin — they are never printed, logged, or written to the repo.

## Setup

With both prerequisites in place:

```bash
bash scripts/cloud-setup.sh
```

It is idempotent — safe to run repeatedly. It will:

1. Check Node ≥ 18.18.
2. `npm ci --prefix server` if `server/node_modules` is absent.
3. `npm install -g @openai/codex` if the CLI is absent.
4. Install bubblewrap if a package manager is available (optional — Codex ships
   its own and falls back to it with a warning).
5. Authenticate from whichever secret is set.
6. Run preflight and exit with its status.

### Automating it per session

The container is ephemeral, so this has to happen every session.
`.claude/hooks/session-start.sh` does it automatically and is registered in
`.claude/settings.json`. It is guarded to the web (`CLAUDE_CODE_REMOTE`) so it
no-ops on a local machine.

The hook deliberately **exits 0 even when preflight fails**. Until egress is
allowlisted a failing preflight is the expected state, and it should not block
your session from starting.

> **Known limitation.** MCP servers are loaded when a session starts, so a hook
> that provisions the broker may not get it *registered* for that same session.
> If the tools do not appear, start a fresh session once provisioning has been
> cached into the container image.

## Verifying

```bash
node scripts/preflight.mjs      # diagnostics, exit 1 on any blocker
cd server && node test/run-tests.mjs   # 41/41, uses a mock codex — no network needed
```

The test suite never touches the network or your OpenAI account, so it passes
even while egress is blocked. It proves the broker is sound; preflight proves the
environment is.

Once everything is green, smoke-test the real thing with `codex_task`, prompt
`Reply with exactly: READY`, `cwd` set to any existing directory.

## Troubleshooting

Keyed to what `scripts/preflight.mjs` reports.

| Preflight says | Meaning | Fix |
|---|---|---|
| `egress — blocked by egress policy` | Proxy refused CONNECT (403/407) | Allowlist `api.openai.com`. Do not retry or route around it. |
| `egress — TLS verification failed` | Proxy's CA is not trusted | Point `NODE_EXTRA_CA_CERTS` at the environment's CA bundle. Never disable verification. |
| `egress — proxy rejected a plain-HTTP request` | `HTTP_PROXY` set where only `HTTPS_PROXY` works | Unset `HTTP_PROXY`. |
| `egress — no route to api.openai.com` | Client is ignoring the proxy | Confirm `HTTPS_PROXY` is set and honored. |
| `codex auth — not logged in` | No secret, or it was rejected | Set `CODEX_ACCESS_TOKEN` or `OPENAI_API_KEY`, re-run setup. |
| `codex cli — not found` | CLI missing | `npm install -g @openai/codex`. |
| `server deps — missing` | Dependencies not installed | `npm ci --prefix server`. |

### A burst of `Reconnecting... n/5` errors, then it works

Expected. Codex 0.146 prefers a WebSocket transport (`wss://api.openai.com`),
which HTTPS-only proxies do not support. It retries, gives up, and falls back to
HTTPS — which works. Noisy, not broken. See [LESSONS.md #9](LESSONS.md).

## What changes about delegation in the cloud

When Codex runs in the same container as Claude they share one filesystem, so the
GitHub round trip that the [git protocol](../skill/references/git-protocol.md)
describes — push, have Codex clone, push back, re-clone to review — is
unnecessary. Delegate with `cwd` pointed at the working directory instead.

This removes the *remote* round trip. It does not necessarily remove the commit
workaround in [LESSONS.md #8](LESSONS.md): Codex's sandbox write-protects an
existing repo's `.git`, so committing may still need to go through the broker's
`git_commit`. Whether that restriction reproduces on Linux has not been verified.
See the skill's "Same-host mode" section.
