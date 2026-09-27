---
name: setup
description: Check that the Codex broker can actually run Codex on this machine (Node, the plugin's server dependencies, Codex CLI version, login, the Windows sandbox, keep-awake, the newest Codex and Claude models at the right effort, git and gh), explain each failure, and walk the user through the fixes. Use after installing or updating the codex-broker plugin, or when broker tools fail.
disable-model-invocation: true
---

# Codex broker setup check

Run the broker's preflight and report what it finds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin
```

It prints one line per check (`OK`, `WARN`, `FAIL`) with a `fix:` line under each problem, and exits 1 if anything required fails. Show the user the result as a short list, then handle each problem as below. Rerun the command after fixes until it prints `Ready.`

## Fixing what it finds

- **node** fails: Node 18.18 or later is required. On Windows: `winget install OpenJS.NodeJS.LTS`, then a new terminal. Ask before installing anything.
- **server-deps** fails: the plugin's automatic dependency install did not run or did not finish. Offer to run `npm ci --ignore-scripts --prefix "${CLAUDE_PLUGIN_ROOT}"` (on Windows PowerShell, `npm.cmd`), then `/reload-plugins`.
- **codex** fails: install or upgrade with `npm install -g @openai/codex@latest` (ask first). If Codex is installed and the check still fails from inside Claude Desktop, the app started before the install and has the old PATH: the user must fully quit and reopen Claude.
- **codex-login** fails: the user runs `codex login` themselves. It is interactive and bills their ChatGPT plan or API key. Never log in for them.
- **codex-sandbox** fails (Windows): Codex can answer prompts but every command it tries is "blocked by policy". The user runs this once from an **administrator** PowerShell, then closes that window:
  `& "$env:APPDATA\npm\codex.cmd" sandbox setup --elevated --current-user`
  Never run it for them; it creates local accounts and firewall rules.
- **codex-model** warns: Codex's catalog has a newer model than the configured executor, the configured effort isn't supported, or the model is due to retire. Tell the user what the doctor found and offer `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure-codex.mjs" --model <newest> --effort ultra`. Never switch the executor without saying so.
- **claude-model** warns: the orchestrator should be the newest Opus at High effort. Offer to set `"model": "opus"` in `~/.claude/settings.json` (the alias tracks the newest Opus; a full id stays pinned). Effort is saved per model: on each new Opus or Fable the user runs `/effort high` and presses Enter. Ask before editing their settings.
- **codex-config** warns: offer `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure-codex.mjs" --model gpt-6-astra --effort ultra`. It backs up `~/.codex/config.toml` first and turns on keep-awake, so a sleeping laptop does not kill long jobs.
- **git** fails: `winget install Git.Git` (ask first).
- **gh** warns: optional; only the `gh_*` tools need it. `winget install GitHub.cli`, then the user runs `gh auth login`.

## When it prints Ready

Confirm the broker end to end with two calls to its `codex_task` tool (the tool's full name ends in `__codex_task`), `cwd` set to the current project:

1. prompt `Reply with exactly: READY`, expect `READY`.
2. `sandbox: "read-only"`, prompt `Run this shell command and reply with only its output, or the exact error: git --version`, expect a git version line. "blocked by policy" means the sandbox step above.

Finally, say which model this session is running on (your system prompt names it) and whether it is the newest Opus. If it isn't, suggest `/model opus`. Then tell the user the broker is ready and that the `codex-delegation` skill explains how to delegate work.
