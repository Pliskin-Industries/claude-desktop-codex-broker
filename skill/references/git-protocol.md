# Git Sync Protocol

You (Fable) run in a cloud container. Codex edits the user's local disk. GitHub
is the only shared surface. Every write delegation goes through git or the work
does not sync. Follow this exactly.

## Preconditions (check before delegating)

Confirm the repo has a GitHub remote from your container:

```bash
git -C <cwd> remote -v
```

If there is no remote, **stop**. Ask the user to add one and push, or to grant a
remote you can both reach. Do not delegate write work with no sync path, and do
not invent one (no patch files over chat, no manual copy). A read-only design
review or `codex_review` can still proceed without a remote, since nothing needs
to sync back.

Confirm you know the integration branch name (`main` or `master`):

```bash
git -C <cwd> symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo "check manually"
```

## Step 1 — Push your current state (in the container)

Codex must pull a clean, current base. Commit and push whatever you have:

```bash
git -C <cwd> add -A
git -C <cwd> commit -m "checkpoint before delegating <task-slug> to codex"
git -C <cwd> push origin <integration-branch>
```

If you have nothing to commit, still confirm your local `HEAD` is pushed:

```bash
git -C <cwd> status --short
git -C <cwd> push origin <integration-branch>
```

## Step 2 — Instruct Codex in its prompt

Codex runs on the user's local clone. Put these git instructions verbatim into
the delegation prompt (adapt the slug and branch):

IMPORTANT (verified in field testing): Codex's sandbox runs as a separate OS
user with no network and no credential access. Codex can init/branch/commit
locally but can NEVER fetch, pull, or push. All remote operations go through
the broker tools (`git_pull`, `git_push`, `gh_repo_create`), which you call
yourself. Call `git_pull(cwd)` BEFORE delegating so Codex starts from current
state.

```
Git protocol — follow exactly:
1. If the working tree is dirty (`git status --short` non-empty), STOP. Either
   `git stash push -u -m "pre-codex autostash"` and note it, or abort and report.
   Never discard, reset, or force over uncommitted local work.
2. `git checkout -b codex/<task-slug>` (or checkout the branch if it already exists).
   Do NOT fetch, pull, or push — you have no network or credential access;
   the orchestrator handles all remote sync.
3. Do the scoped work. Stay inside the files-in-scope list.
4. Run the project's test command. If tests fail, fix within scope or stop and
   report — do NOT commit failing work.
5. `git add <only in-scope paths>` then commit with a clear message.
6. Do not push. Never commit to <integration-branch> directly.
7. Report: branch name, commit SHAs, files touched, test results.
```

## Step 3 — Review in the cloud

Once Codex reports its commit, push the branch yourself via the broker:
`git_push(cwd, "codex/<task-slug>")`. Then:

```bash
git -C <cwd> fetch origin
git -C <cwd> checkout codex/<task-slug>          # or: git -C <cwd> branch codex/<slug> origin/codex/<slug>
git -C <cwd> pull --ff-only origin codex/<task-slug>
git -C <cwd> diff <integration-branch>...codex/<task-slug>   # three-dot: changes on the branch since it forked
```

Review the full diff. Then run the tests yourself in the container — do not trust
Codex's report that they passed:

```bash
# use the project's actual test command
<project test command>
```

## Step 4 — Merge or send back

**Accept:**

```bash
git -C <cwd> checkout <integration-branch>
git -C <cwd> merge --no-ff codex/<task-slug> -m "merge codex/<task-slug>: <summary>"
git -C <cwd> push origin <integration-branch>
```

**Send back for revision** — keep the same Codex thread with the delta only:

```
codex_resume(thread_id=<id>, prompt="<specific, evidence-backed feedback: what
to change, which file/line, why. Re-run tests. Commit to the same
codex/<task-slug> branch — do not push; I handle the push.>", cwd=<cwd>)
```

After Codex commits the revision, push it yourself: `git_push(cwd, "codex/<task-slug>")`.
```
```

Then re-fetch and re-review (Step 3). Repeat until it meets your bar.

## Edge cases

- **Dirty local tree.** Handled in the Codex prompt above — stash or abort, never
  force. If Codex reports it stashed, remind the user their stash is
  `pre-codex autostash`.
- **Branch already exists** (a prior delegation of the same slug). Have Codex
  check out and continue it rather than clobbering, or pick a new slug
  (`codex/<task-slug>-2`).
- **Merge conflict on your side.** You resolve it in the container — this is
  integration, which is your job, not Codex's. Do not send conflict resolution to
  Codex unless the conflict is genuinely inside its scoped logic.
- **Push rejected (non-fast-forward).** Someone moved the branch. Fetch and
  inspect before doing anything. Never `push --force`.
- **No remote mid-task.** If the remote disappears or auth fails, stop and report
  to the user. Do not fall back to an unsynced workflow.
