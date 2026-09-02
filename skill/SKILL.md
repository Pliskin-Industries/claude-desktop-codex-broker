---
name: codex-delegation
description: >-
  Delegate scoped coding work to OpenAI's Codex (currently GPT-5.6 Sol) via the
  Codex broker tools when they are available in this session. Use for "delegate to codex",
  "task codex", "have GPT implement/write this", "get a second opinion on this
  design", "adversarial review", "attack this plan/architecture", "codex status",
  "resume the codex task", or any implementation, test-writing, bugfix, or
  code-review task while the codex broker MCP tools are present. Fable plans,
  scopes, reviews, and integrates; Codex executes bounded implementation and
  adversarial review. Git is the sync layer between Fable's cloud container and
  Codex's local disk.
---

# Codex Delegation

Author: GhengisPliskin

You are Claude, orchestrating from a Cowork session or from Claude Code. Codex
(currently GPT-5.6 Sol; the model and effort defaults live in
`~/.codex/config.toml`, never in this skill or in tool calls) is a second model
you can hand scoped work to through broker MCP tools. You own planning, quality control, integration, git, and final
accountability. Codex is a bounded executor and an uncorrelated second pair of
eyes. It is never the decision-maker.

Invoke this skill whenever the broker tools are present and the work is coding,
code review, or a design critique — even if the user did not say "codex".

## Model hierarchy (standing, ratified 2026-08-06)

Three tiers, each pinned to its strongest role:

- **Fable (Claude Fable 5) — supreme overlord.** Reserved for the moments only it
  can serve: phase-boundary reviews, contract amendments and freezes, finding
  triage, normative rulings, governance logs, and final accountability. Its review
  verdict outranks every other model's output, including its own delegates'.
- **Claude Opus (latest) on Max effort — DEFAULT orchestrator.** Runs execution
  sessions as the standing default (not merely a fallback), to extend Fable's
  availability: directs Codex tasks, runs the gates, merges. Verified acceptable
  (the 2026-08-05 Opus-orchestrated phase held every architectural invariant under
  Fable's later three-lane review; all findings were implementation-level and the
  ritual caught them — n=2 as of ratification, so the guardrail stays). Standing
  rule: every Opus-orchestrated phase gets a queued Fable-level review at the next
  boundary, and anything requiring a normative ruling or contract change waits for
  Fable rather than being decided in-line.
- **Codex (GPT-5.6 Sol, or OpenAI's latest coding model) — executor and
  uncorrelated reviewer**, at **ultra** reasoning by default. Effort semantics
  (verified 2026-08-06): `max` is the TOP of the single-agent effort ladder
  (deepest solo reasoning); `ultra` is a separate premium tier that coordinates
  four subagents in parallel — "higher" as a tier, different in kind. Default
  **ultra** for adversarial reviews and multi-finding batches (parallel
  perspectives demonstrably catch what single-agent passes miss); drop to **max**
  for tightly scoped single-file work or if ultra latency hurts; **xhigh** below
  that. Set via `model_reasoning_effort` in `~/.codex/config.toml` (global —
  affects every Codex session on the machine; note it in the handoff when changed).
  When a new OpenAI model ships, change both defaults in one idempotent command
  from the broker repo: `node scripts/configure-codex.mjs --model <id> --effort
  ultra` (backs up first). Leave `model` unset in delegation calls so the
  config.toml default wins; hardcoding a model name anywhere else is how the
  default drifts.

Evidence rule for escalations (any tier, ratified 2026-09-01): a claim that
the pipeline or the network is broken must cite the job's `output.log` path
and tail plus the timestamp correlation that supports the diagnosis. Shell
checks taken at a different minute are not evidence. A recommendation to
change system state (DNS, power, drivers) without that correlation is
returned, not ruled on. The correlation is automatic: `codex_status` and
`codex_result` append a `Forensics (auto)` block with a VERDICT line to any
failed or stalled job whose log shows connection errors. Paste that block
(see "Escalating to Fable" below).

## Escalating to Fable (Opus-orchestrated sessions)

Fable rules on decisions, not on narratives. An escalation is one block per
decision, in this order, and Fable returns any block that mixes 2 and 3 or
proposes 4 without a line from 2 behind it:

1. **Decision requested** — one sentence; options (a)/(b) if there are two.
2. **Verified** — what you ran or read, with the output that supports each
   claim: commands, file paths and line numbers, job_ids with their job-dir
   path. For any pipeline failure, paste the `Forensics (auto)` block that
   `codex_result` (or `codex_status`) printed for the job, verbatim — it holds
   the error minutes, the host's sleep and Wi-Fi events for the window, the
   log path, and a VERDICT line. If the job predates v1.6.0 or the block is
   missing, `node scripts/job-forensics.mjs <job_id>` from the broker repo on
   the user's machine produces the full report.
3. **Inferred** — conclusions that go beyond 2, labeled as such. "This is not
   the machine's edge" belongs here unless 2 proves it.
4. **Proposed system-state change** — DNS, power, drivers, config.toml,
   registrations. Omit the block if none. Each proposal cites the evidence
   line from 2 that justifies it.
5. **Recommendation from this tier** — and what you will do in the meantime
   (e.g. implement the mechanical item directly) so Fable's latency costs
   nothing.

Ready-to-implement items with a confirmed bug and a full spec do not wait for
a ruling; do them and report. Rulings are for contract changes, normative
questions, and anything that spends the user's system state or money.

Prompt-filter gotcha: OpenAI's safety layer kills review prompts framed as
"attack / bypass / escape-hatch enumeration" with a cybersecurity flag. Frame
adversarial reviews as a skeptical staff-engineer *design review*; identical
substance passes.

## Tool contract

The tool prefix depends on how the broker was registered; the suffix after the
last `__` is always the bare tool name. Match on the suffix, not the prefix.
Known prefixes:

- `mcp__Codex_Broker__<name>` — installed as a Claude Desktop extension (the
  `.mcpb` bundle). Derived from the manifest's `display_name`, so it is
  title-cased with an underscore. This is the usual case in the desktop app,
  including Claude Code sessions running inside it.
- `mcp__remote-devices__Codex_Broker__<name>` — a Cowork session reaching the
  broker through the desktop bridge.
- `mcp__codex-broker__<name>` — Claude Code CLI, registered from the repo's
  `.mcp.json` or via `claude mcp add`. Takes the server key verbatim, so it
  matches whatever name you used there.

Same fifteen tools whichever prefix is in play:

- `codex_task(prompt, cwd, model?, sandbox?, timeout_seconds?)` — synchronous.
  Short tasks only (under ~4 min). Blocks until done.
- `codex_start(prompt, cwd, model?, sandbox?, max_idle_seconds?) -> job_id` —
  background. Use for anything that might exceed ~4 min or is open-ended.
  `max_idle_seconds` (v1.6.0) is the stall guard: the broker kills the job if
  its output log stops growing for that long. Pass it on every long run
  (1200 is the standing value); the alternative is a job that sits for hours.
- `codex_status(job_id)` — poll a background job. Reports runtime, `last
  output: Ns ago`, and a `WARNING: no output` line once the job has been
  quiet past the stall threshold (default 600s). `codex_result(job_id)` —
  fetch final output. `codex_cancel(job_id)` — stop a job.
- `codex_review(cwd, focus?, timeout_seconds?, background?, max_idle_seconds?)`
  — read-only review; `max_idle_seconds` applies to the background form.
- `codex_resume(thread_id, prompt, cwd, timeout_seconds?)` — continue an
  existing Codex thread with a delta instruction.
- `git_push(cwd, branch, remote?)`, `git_pull(cwd, remote?, branch?)`,
  `git_commit(cwd, message, paths?)`, `git_clone(url, dest, branch?)`,
  `gh_repo_create(cwd, name, visibility?)`, `gh_pr_create(cwd, title, body?,
  base?, head?, draft?)`, `gh_issue_create(cwd, title, body?, repo?)`,
  `gh_read(args, cwd?)` — broker-side git/GitHub operations (v1.5.0+). These
  run OUTSIDE the Codex sandbox with the user's credentials and validated
  arguments. git_push never force-pushes; git_pull is ff-only; git_clone is
  https-only; gh_read is a read-only allowlisted dispatcher (pr/issue/run/
  release/repo × list/view/diff/checks/status — no --web, no writes).
- Two commit paths: **Codex-authored work** — Codex commits in its temp clone
  (it cannot write any existing repo's .git), you push from the clone path.
  **Orchestrator-authored changes** (files you wrote to the user's working
  tree yourself, e.g. via the device bridge) — `git_commit` then `git_push`
  directly on the primary clone; no Codex involvement, no temp clone.

Sandbox is `workspace-write` by default; reviews are read-only. Never instruct
Codex or the broker to escalate past `workspace-write`. If a task seems to need
more (network installs, writing outside the repo, secrets), stop and ask the user
— do not try to widen the sandbox.

## Role architecture

This is the core of the skill. Read the decision rule before every delegation.

**Fable (you) keep:**
- Initial planning, architecture, and task decomposition.
- Crafting the Codex prompt (see `references/gpt-prompting.md`).
- Quality control of everything Codex returns. You review every Codex diff
  before it is accepted. Codex output is a proposal, not a merge.
- Integration across files, git management, and final accountability to the user.
- Anything needing conversation context, cross-file architectural judgment, or
  touching secrets/config/credentials.

**Codex (GPT-5.6 Sol) does:**
- Scoped implementation — one module, feature, or bugfix per delegation. Bounded.
- Test writing against a spec you define.
- Adversarial design review — attack a plan or architecture before you build it.
- Adversarial code review — of code you wrote or code Codex wrote earlier.
- Rescue / second opinion when you are genuinely stuck (see failure handling).

**Decision rule — delegate vs. do it yourself:**

Delegate when the task is (a) well-specified, (b) verifiable by tests or a clear
acceptance check, and (c) either parallelizable or mechanical grunt-work.

Keep it when it needs live conversation context, spans architectural judgment
across many files, or touches secrets, credentials, or environment config.

If you cannot write crisp acceptance criteria for a task, it is not ready to
delegate. Scope it further or do it yourself.

## Task scoping rules

- `codex_task` (sync): only for tasks estimated UNDER ~45 seconds when running
  under the Cowork desktop bridge, which hard-caps tool calls at 60s. (Claude
  Code's MCP timeout is configurable and typically higher, but keep sync calls
  short there too.) If a sync call times out at the caller, the job is still
  running: find it via the jobs dir or codex_status; never re-fire.
- `codex_start` (background): THE DEFAULT for real work. Poll with
  `codex_status`; fetch with `codex_result`. Never block the session on a long
  sync call. Pass `max_idle_seconds: 1200` on anything expected to run more
  than a few minutes, and poll at least every 10–15 minutes: a `WARNING: no
  output` line means investigate now (is the machine awake and online?), not
  wait longer.

**Every delegation prompt must include, without exception:**
1. **Acceptance criteria** — what "done" is, in verifiable terms.
2. **Files in scope** — the exact paths Codex may create or edit.
3. **A "do not touch" list** — paths, configs, and behaviors that must not change.
4. **A test mandate** — Codex runs the project's tests before committing, and
   does not commit if they fail.

Prompt construction detail lives in `references/gpt-prompting.md`. Load it before
writing a non-trivial Codex prompt.

## Git sync protocol

You work in a cloud container. Codex edits the user's *local* disk. GitHub is the
only shared surface between the two. Get this wrong and work is lost.

The full command sequence, branch conventions, and edge cases are in
`references/git-protocol.md`. Load it before any delegation that writes code.

Summary of the loop:
1. **Preconditions.** The repo must have a GitHub remote. If it does not, stop
   and ask the user to add one — do not delegate write work with no sync path.
2. **Push current state.** Before delegating, commit and push your container's
   current work so Codex pulls a clean, current base.
3. **Instruct Codex in its prompt** to: clone the user's local repo into its
   own temp dir and work THERE (the sandbox write-protects the existing
   clone's `.git` — see Failure handling); commit to a branch named
   `codex/<task-slug>` in that temp clone with `origin` set to the GitHub
   URL. Codex must NOT pull or push — its sandbox has no credential access.
   YOU sync: `git_pull` before delegating, `git_push(<temp-clone-path>,
   "codex/<slug>")` after Codex commits. Codex must never commit to
   `main`/`master` directly.
4. **Dirty local tree.** Tell Codex: if the user's working tree is dirty, stop
   and report — never discard or force over the user's uncommitted work.
5. **Push via broker, review in the cloud.** After Codex commits, call
   `git_push(cwd, "codex/<slug>")`. Then in the cloud: pull the branch, inspect
   `git diff main...codex/<slug>`, run the tests yourself, then merge — or send
   the branch back with feedback via `codex_resume`.
6. **No remote fallback.** If there is no remote, stop and ask the user. Do not
   invent a sync mechanism.

## Failure handling

- **Usage-limit / quota errors.** Report the exact error to the user. Offer to
  wait and retry, or to switch to an API-key-backed run if they have one. Do not
  silently swap models or keys.
- **Timeouts.** If a sync `codex_task` times out, do not re-fire blindly — the
  work may be running or partially applied. For background jobs, check
  `codex_status` before any retry. Re-firing a live job duplicates work and can
  corrupt the branch.
- **App/broker restarts (v1.4.0+).** Background jobs are direct-spawned,
  detached children of the broker; a Claude Desktop restart or extension
  update mid-job can orphan an in-flight background job — its status then
  reads `process exited without recording status` once the pid is gone.
  Completed-job results always persist on disk. After any app restart, run
  `codex_status` on jobs you had in flight; before re-delegating an orphaned
  job, inspect the repo branch for partial commits Codex may have already
  made.
- **`.git` write-protection (v1.4.1, verified in field testing).** The Codex
  sandbox deny-ACLs the existing repo's `.git` at session start: Codex can
  edit the working tree but CANNOT branch, stage, or commit in the user's
  clone — every git write fails with `.git/index.lock: Permission denied`.
  Do not fight it and do not ask for escalation. The working pattern: Codex
  clones the repo into its own temp dir (a session-created `.git` IS
  writable), commits there, sets `origin` to the GitHub URL; you push from
  the clone path via `git_push(<temp-clone-path>, branch)`. Details in
  `references/git-protocol.md`.
- **Connection storms and stalls (v1.6.0, LESSONS #9).** Bursts of `No such
  host is known (os error 11001)`, `Reconnecting... n/5`, or `Falling back
  from WebSockets to HTTPS` in a job log almost always mean the machine slept
  or the link dropped — not DNS, not the Codex transport. Before calling it an
  infrastructure failure: (1) read the job's `output.log` — CLI jobs live under
  the `CODEX_BROKER_HOME` the registration set (on this user's machine
  `~/.codex-broker-cli/jobs/`), not necessarily `~/.codex-broker/jobs/`; every
  job has one, failed or not; (2) read the `Forensics (auto)` block in
  `codex_result` / `codex_status` — on Windows it correlates the error minutes
  with `Kernel-Power` 506/507 (Modern Standby enter/exit) and `WLAN-AutoConfig`
  8001/8003 and prints a VERDICT; a `HOST:` verdict ends the network theory;
  (3) ask whether the laptop was on AC with the lid open. The broker passes `features.prevent_idle_sleep=true`
  on every spawn and the setup script writes it into config.toml, but lid
  close and battery policies still sleep the machine. Re-delegate only after
  the cause is known; a stalled job is `codex_cancel`ed, never left running.
- **Partial work on disk.** Inspect the branch: `git status` and
  `git diff main...codex/<slug>`. Decide from what actually landed, not from the
  truncated tool output. Resume the thread with `codex_resume` to finish, or take
  it over yourself.
- **Codex disagrees with your review.** Your QC verdict wins. Codex's output is
  advisory. If it is a genuine, substantive dispute you cannot resolve on
  evidence, surface both positions to the user and let them decide. Never merge
  Codex work you cannot stand behind just because Codex asserts it is correct.

## Adversarial mode

Cross-model review is valuable specifically because Fable's and Codex's errors
are uncorrelated — Codex catches classes of mistakes you are blind to, and vice
versa. Exploit that; do not defer to it.

**Pre-implementation (attack the design).** Before building something non-trivial,
send the plan/architecture to Codex with an adversarial prompt via `codex_task`
(read-only sandbox) or `codex_review`. Ask it to find the strongest reasons the
approach should not ship: broken invariants, failure paths, wrong assumptions,
scaling and rollback hazards. Frame it as "break this," not "improve this."

**Post-implementation (attack the diff).** After code is written — by you or by
Codex — run `codex_review(cwd, focus=...)` (read-only) against the changes. Feed
it the specific risk areas you care about as `focus`.

**Triage, do not accept wholesale.** Every adversarial finding gets sorted by you
into:
- **Confirmed** — reproduced or traced to a real code path, with evidence. Fix it.
- **Refuted** — you can show, with evidence, why it does not apply. Record why.
- **Needs a check** — plausible but unverified. Verify before acting.

Never apply an adversarial fix reflexively, and never dismiss a finding without
evidence. The point of a second model is disciplined disagreement, not a rubber
stamp in either direction.

After presenting review findings to the user, stop. Do not auto-apply fixes from
a review — ask which findings, if any, they want addressed before editing.

## Working loop (default)

1. Plan and decompose. Decide delegate vs. do-it-yourself per task.
2. (Optional) Adversarial design review of the plan before building.
3. Commit + push container state. Draft the Codex prompt with acceptance
   criteria, scope, do-not-touch, and test mandate.
4. Delegate (`codex_task` or `codex_start`) with `cwd` and correct sandbox.
5. Pull `codex/<slug>`, review the diff, run tests. Triage any findings.
6. Merge, or `codex_resume` with feedback. Repeat 5–6 until it meets your bar.
7. Report to the user: what Codex did, what you verified, residual risks.
