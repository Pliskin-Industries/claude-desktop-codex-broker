---
name: codex-delegation
description: >-
  Delegate scoped coding work to OpenAI's GPT-5.6 Sol model via the Codex broker
  tools when they are available in this session. Use for "delegate to codex",
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
(GPT-5.6 Sol) is a second model you can hand scoped work to through broker MCP
tools. You own planning, quality control, integration, git, and final
accountability. Codex is a bounded executor and an uncorrelated second pair of
eyes. It is never the decision-maker.

Invoke this skill whenever the broker tools are present and the work is coding,
code review, or a design critique — even if the user did not say "codex".

## Tool contract

Tool names depend on the host. In a Cowork session the broker is proxied
through the desktop bridge as `mcp__remote-devices__Codex_Broker__<name>`; in
Claude Code (registered via the repo's `.mcp.json` or `claude mcp add`) they
appear as `mcp__codex-broker__<name>`. Same ten tools either way:

- `codex_task(prompt, cwd, model?, sandbox?, timeout_seconds?)` — synchronous.
  Short tasks only (under ~4 min). Blocks until done.
- `codex_start(prompt, cwd, model?, sandbox?) -> job_id` — background. Use for
  anything that might exceed ~4 min or is open-ended.
- `codex_status(job_id)` — poll a background job. `codex_result(job_id)` — fetch
  final output. `codex_cancel(job_id)` — stop a job.
- `codex_review(cwd, focus?, timeout_seconds?, background?)` — read-only review.
- `codex_resume(thread_id, prompt, cwd, timeout_seconds?)` — continue an
  existing Codex thread with a delta instruction.
- `git_push(cwd, branch, remote?)`, `git_pull(cwd, remote?, branch?)`,
  `gh_repo_create(cwd, name, visibility?)` — broker-side git/GitHub operations.
  These run OUTSIDE the Codex sandbox (Codex cannot push: its sandbox runs as a
  separate OS user with no credential access). Codex commits; YOU push via
  these tools after reviewing. git_push never force-pushes; git_pull is
  ff-only.

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
  sync call.

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
