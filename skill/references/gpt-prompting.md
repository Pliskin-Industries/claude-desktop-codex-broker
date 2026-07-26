# Prompting GPT-5.6 Sol via Codex

How to write the `prompt` you pass to `codex_task`, `codex_start`, `codex_review`,
and `codex_resume`. Adapted from OpenAI's own GPT-5.x coding-model prompting
guidance; the techniques are model-family-generic and apply to GPT-5.6 Sol.

## Core stance

Prompt Codex like an operator, not a collaborator. Compact, block-structured,
XML-tagged. State the task, the output contract, the follow-through defaults, and
the few extra constraints that matter. Nothing else.

Rules:
- **One clear task per run.** Split unrelated asks into separate delegations.
  Mixing "implement X, fix Y, update docs, suggest a roadmap" into one run
  degrades all four.
- **Tell Codex what "done" looks like.** Do not assume it infers the end state.
  This is where your acceptance criteria go.
- **Add grounding and verification** for any task where an unsupported guess
  hurts quality.
- **Fix the contract before raising effort.** A tighter prompt beats "think
  harder" and beats a higher reasoning setting. Escalate reasoning only after the
  contract is already crisp.
- **Reuse stable XML tag names** so prompts have consistent internal structure.

## Default recipe

Assemble from these blocks. Use the smallest set that makes the answer usable.

- `<task>` — the concrete job plus the relevant repo/failure context and the
  expected end state. Nearly every prompt.
- `<structured_output_contract>` / `<compact_output_contract>` — exact shape,
  ordering, brevity. Highest-value items first.
- `<default_follow_through_policy>` — what to do by default instead of stopping
  to ask routine questions.
- `<verification_loop>` / `<completeness_contract>` — required for debugging,
  implementation, or risky fixes.
- `<grounding_rules>` / `<citation_rules>` — required for review, research, or
  anything that can drift into unsupported claims.
- `<action_safety>` — for any write-capable run: keep changes scoped, no
  unrelated refactors or renames.
- `<missing_context_gating>` — when Codex might otherwise guess repo facts.

Which blocks by task type:
- **Implementation / bugfix:** `completeness_contract`, `verification_loop`,
  `action_safety`, `missing_context_gating`.
- **Code review / adversarial:** `grounding_rules`, `structured_output_contract`,
  `dig_deeper_nudge`.
- **Design critique / research:** `research_mode`, `citation_rules`.

## Reusable blocks

```xml
<task>
Concrete job, relevant repo/failure context, and the expected end state.
</task>
```

```xml
<structured_output_contract>
Return exactly the requested shape and nothing else. Keep it compact.
Put the highest-value findings or decisions first.
</structured_output_contract>
```

```xml
<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
Only stop to ask when a missing detail changes correctness, safety, or an
irreversible action.
</default_follow_through_policy>
```

```xml
<completeness_contract>
Resolve the task fully before stopping. Do not stop at the first plausible
answer. Check for follow-on fixes, edge cases, and cleanup needed for a correct
result.
</completeness_contract>
```

```xml
<verification_loop>
Before finalizing, verify the result against the task requirements and the
changed files or tool outputs. If a check fails, revise instead of reporting the
first draft.
</verification_loop>
```

```xml
<missing_context_gating>
Do not guess missing repository facts. If required context is absent, retrieve it
with tools or state exactly what remains unknown.
</missing_context_gating>
```

```xml
<grounding_rules>
Ground every claim in the provided context or your tool outputs. Do not present
inferences as facts. Label any hypothesis clearly.
</grounding_rules>
```

```xml
<action_safety>
Keep changes tightly scoped to the stated task. Avoid unrelated refactors,
renames, or cleanup unless required for correctness. Call out any risky or
irreversible action before taking it.
</action_safety>
```

```xml
<dig_deeper_nudge>
After the first plausible issue, check for second-order failures, empty-state
behavior, retries, stale state, and rollback paths before finalizing.
</dig_deeper_nudge>
```

```xml
<research_mode>
Separate observed facts, reasoned inferences, and open questions. Prefer breadth
first, then go deeper only where the evidence changes the recommendation.
</research_mode>
```

## Task template — scoped implementation

```xml
<task>
Implement <feature/fix> in this repository. Expected end state: <acceptance
criteria, verifiable>.
Files in scope: <exact paths>.
Do not touch: <paths, configs, behaviors that must not change>.
</task>

<completeness_contract>
Resolve the task fully. Do not stop after a partial change.
</completeness_contract>

<verification_loop>
Run the project's tests (<command>) before finalizing. If they fail, fix within
scope or stop and report. Do not commit failing work.
</verification_loop>

<action_safety>
Stay inside the files-in-scope list. No unrelated refactors or renames.
</action_safety>

<structured_output_contract>
Return: 1) summary of the change  2) files touched  3) test results
4) residual risks or follow-ups.
</structured_output_contract>
```

Append the git protocol block from `git-protocol.md` for any write task.

## Task template — adversarial review

Use with `codex_review` (read-only) or a read-only `codex_task`. Frame it as
"break this," not "improve this."

```xml
<role>
You are performing an adversarial review. Your job is to break confidence in this
change/design, not to validate it.
</role>

<task>
Find the strongest reasons this should not ship. Target: <diff or design>.
Focus: <the specific risk areas Fable cares about>.
</task>

<attack_surface>
Prioritize expensive, dangerous, or hard-to-detect failures: auth and trust
boundaries; data loss/corruption; rollback, retries, partial failure,
idempotency; race conditions and ordering; empty-state/null/timeout/degraded
dependency behavior; schema/version skew and migration hazards; observability
gaps.
</attack_surface>

<grounding_rules>
Every finding must be defensible from the provided context. Do not invent files,
lines, code paths, or runtime behavior. If a conclusion depends on an inference,
say so and keep confidence honest.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones. No style or naming nitpicks. If
it looks safe, say so and return no findings.
</calibration_rules>

<structured_output_contract>
Return findings ordered by severity. Each: affected file + line range, what can
go wrong, why that path is vulnerable, likely impact, concrete fix, confidence
0–1.
</structured_output_contract>
```

## Resume (follow-up on the same thread)

With `codex_resume`, send only the delta instruction. Do not restate the whole
prompt unless the direction changed materially. Example: "Tests still fail on
`test_auth_expiry` — the token TTL comparison is off by the clock-skew window.
Fix in `auth/session.py`, re-run tests, push to the same branch."

## Anti-patterns

- Vague framing ("take a look and tell me what you think"). Give a task and a
  contract.
- No output contract ("investigate and report back"). Specify the shape.
- No follow-through default on a multi-step task — Codex stops early.
- "Think harder / be smart" instead of a verification loop.
- Multiple unrelated jobs in one run.
- Demanding certainty ("tell me exactly why prod failed") without grounding rules
  — invites confident fabrication.
