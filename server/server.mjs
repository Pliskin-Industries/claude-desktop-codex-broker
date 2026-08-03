#!/usr/bin/env node
// Codex broker: a local stdio MCP server that lets Claude delegate coding tasks
// to OpenAI's Codex CLI. Long runs are fire-and-poll background jobs so they
// never hit MCP/tool timeouts. See README.md.
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  DEFAULT_SANDBOX,
  ALLOWED_SANDBOXES,
  ValidationError,
  clampTimeoutSeconds,
  resolveCodexBinary,
  lastLines,
  requireString,
  resolveModel,
  truncate,
  validateCwd,
  validateSandbox,
} from "./lib/util.mjs";
import { buildResumeArgs, buildReviewArgs, buildTaskArgs } from "./lib/codex.mjs";
import { runPlainCommand } from "./lib/jobs.mjs";
import {
  resolveGitBinary,
  resolveGhBinary,
  validateRepoName,
  validateRefName,
  validateHttpsGitUrl,
  validateNewDirPath,
  validateCommitMessage,
  validatePathspec,
  validateGhReadArgs,
  validateTextField,
  validateOwnerRepo,
} from "./lib/util.mjs";
import { cancelJob, jobExists, readJob, runSyncJob, startJob } from "./lib/jobs.mjs";

const DEFAULT_TASK_TIMEOUT = 240;
const DEFAULT_REVIEW_TIMEOUT = 600;

function textResult(text, isError = false) {
  return { content: [{ type: "text", text: truncate(text) }], isError };
}

function sessionLine(sessionId) {
  return sessionId
    ? `Session id: ${sessionId}  (pass as thread_id to codex_resume to continue)`
    : `Session id: (not detected in codex output)`;
}

// Render the outcome of a finished/awaited sync job into concise text.
function renderSyncOutcome(kind, job, { timedOut, timeoutSeconds }) {
  if (!job) return textResult(`${kind}: job record missing after start.`, true);

  const header = [];
  const tail = lastLines(job.logText, 20);

  if (timedOut) {
    header.push(
      `TIMEOUT: ${kind} exceeded ${timeoutSeconds}s and the process tree was killed.`
    );
    header.push(sessionLine(job.sessionId));
    header.push(`Runtime: ${job.runtimeSeconds}s`);
    header.push("");
    if (job.finalMessage) {
      header.push("Partial final message:");
      header.push(job.finalMessage);
      header.push("");
    }
    header.push("Partial output (last lines):");
    header.push(tail || "(no output captured)");
    return textResult(header.join("\n"), true);
  }

  if (job.status === "completed") {
    header.push(`Status: completed (exit 0)`);
    header.push(sessionLine(job.sessionId));
    header.push(`Runtime: ${job.runtimeSeconds}s`);
    header.push("");
    header.push(job.finalMessage || tail || "(codex produced no final message)");
    return textResult(header.join("\n"), false);
  }

  // failed
  header.push(`Status: failed (${job.reason || "unknown"})`);
  header.push(sessionLine(job.sessionId));
  header.push(`Runtime: ${job.runtimeSeconds}s`);
  header.push("");
  if (job.finalMessage) {
    header.push("Final message (if any):");
    header.push(job.finalMessage);
    header.push("");
  }
  header.push("Output (last lines):");
  header.push(tail || "(no output captured)");
  return textResult(header.join("\n"), true);
}

// ---------------------------------------------------------------------------

const server = new Server(
  { name: "codex-broker", version: "1.5.1" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "codex_task",
    description:
      "Delegate a coding task to Codex synchronously: run `codex exec`, wait for it to finish (up to timeout_seconds), and return the final assistant message plus the session id (for codex_resume). Kills the process and returns partial output on timeout.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task/instructions for Codex." },
        cwd: { type: "string", description: "Absolute path to the working directory (must exist)." },
        model: { type: "string", description: "Optional model override (else CODEX_MODEL env, else codex default)." },
        network: {
          type: "boolean",
          description: "Allow outbound network for this run (git push/pull, package installs). Default false. Filesystem sandbox unchanged.",
        },
        sandbox: {
          type: "string",
          enum: ALLOWED_SANDBOXES,
          description: `Sandbox policy (default ${DEFAULT_SANDBOX}).`,
        },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default 240)." },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "codex_start",
    description:
      "Start a Codex coding task in the background (codex spawned directly, detached) and return a job_id immediately. Poll with codex_status and fetch the outcome with codex_result. Completed results persist on disk; a broker restart mid-job may orphan the in-flight job.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        cwd: { type: "string", description: "Absolute path to the working directory (must exist)." },
        model: { type: "string" },
        sandbox: { type: "string", enum: ALLOWED_SANDBOXES, description: `default ${DEFAULT_SANDBOX}` },
        network: { type: "boolean", description: "Allow outbound network for this run. Default false." },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "codex_status",
    description:
      "Get the status of a background job: running | completed | failed, runtime so far, and the last ~20 lines of output.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "codex_result",
    description:
      "Get the final result of a job: final assistant message, session id, and exit status. Returns an error if the job is still running.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "codex_cancel",
    description: "Cancel a running job by killing its process tree.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "codex_review",
    description:
      "Run `codex exec review` (read-only) against a repository. Optional focus text is passed as review guidance. Set background:true to return a job_id instead of waiting.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to the git repository to review." },
        focus: { type: "string", description: "Optional review focus/guidance appended as the review instruction." },
        timeout_seconds: { type: "number", description: "Max seconds to wait when not backgrounded (default 600)." },
        background: { type: "boolean", description: "If true, behaves like codex_start and returns a job_id." },
        model: { type: "string" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "codex_resume",
    description:
      "Continue a previous Codex session. Provide the thread_id (the Codex session id surfaced by codex_task/codex_result) and a new prompt. Runs synchronously and returns the final message.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "The Codex session/thread id to resume." },
        prompt: { type: "string" },
        cwd: { type: "string", description: "Absolute path to the working directory (must exist)." },
        model: { type: "string" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default 240)." },
      },
      required: ["thread_id", "prompt", "cwd"],
    },
  },
  {
    name: "git_push",
    description:
      "Broker-side git push (runs OUTSIDE the Codex sandbox so credentials work). Pushes an existing local branch to the remote. Never force-pushes. Use after Codex has committed work locally.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to the local git repository." },
        branch: { type: "string", description: "Branch to push (e.g. main or codex/my-task)." },
        remote: { type: "string", description: "Remote name. Default origin." },
        set_upstream: { type: "boolean", description: "Pass -u to set upstream. Default true." },
      },
      required: ["cwd", "branch"],
    },
  },
  {
    name: "git_pull",
    description:
      "Broker-side git pull --ff-only (runs OUTSIDE the Codex sandbox so credentials work). Fast-forward only; never merges or rebases.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to the local git repository." },
        remote: { type: "string", description: "Remote name. Default origin." },
        branch: { type: "string", description: "Branch to pull. Default: current branch." },
      },
      required: ["cwd"],
    },
  },
  {
    name: "gh_repo_create",
    description:
      "Broker-side GitHub repo creation via gh CLI (runs OUTSIDE the Codex sandbox so auth works). Creates the repo from the local repository at cwd and pushes it.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to the local git repository to publish." },
        name: { type: "string", description: "Repo name (owner/name or bare name for the authenticated user)." },
        visibility: { type: "string", enum: ["public", "private"], description: "Default public." },
      },
      required: ["cwd", "name"],
    },
  },
  {
    name: "git_commit",
    description:
      "Broker-side git stage + commit (runs OUTSIDE the Codex sandbox — use for orchestrator-authored changes already written to the working tree; Codex cannot write .git). Stages then commits in one call. Fails cleanly if there is nothing to commit.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to the local git repository." },
        message: { type: "string", description: "Commit message (max 4000 chars)." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional relative pathspecs to stage (git add -- <paths>). Omit to stage everything (git add -A).",
        },
      },
      required: ["cwd", "message"],
    },
  },
  {
    name: "git_clone",
    description:
      "Broker-side git clone (credentialed, outside the Codex sandbox). https URLs only; dest must be a new absolute path. Use to bring a repo onto disk for Codex to review or work on.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https clone URL (e.g. https://github.com/owner/repo.git)." },
        dest: { type: "string", description: "Absolute path for the new clone directory (must not exist)." },
        branch: { type: "string", description: "Optional branch to check out." },
      },
      required: ["url", "dest"],
    },
  },
  {
    name: "gh_read",
    description:
      "Broker-side read-only gh CLI dispatcher (credentialed). args is the gh argv, restricted to an allowlist: pr {list,view,diff,checks,status}, issue {list,view,status}, run {list,view}, release {list,view}, repo {view}. Extra flags like --repo owner/name, --limit, --json pass through; --web is refused. Example: args=[\"pr\",\"list\",\"--repo\",\"owner/name\",\"--limit\",\"10\"].",
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "gh argv, e.g. [\"pr\",\"view\",\"123\",\"--repo\",\"owner/name\"]." },
        cwd: { type: "string", description: "Optional repo directory for context. Default: broker home." },
      },
      required: ["args"],
    },
  },
  {
    name: "gh_pr_create",
    description:
      "Broker-side gh pr create (credentialed). Creates a pull request from the repo at cwd. Head defaults to the current branch. Never merges.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to the local git repository." },
        title: { type: "string", description: "PR title (max 300 chars)." },
        body: { type: "string", description: "PR body (max 20000 chars). Default empty." },
        base: { type: "string", description: "Base branch. Default: repo default branch." },
        head: { type: "string", description: "Head branch. Default: current branch." },
        draft: { type: "boolean", description: "Create as draft. Default false." },
      },
      required: ["cwd", "title"],
    },
  },
  {
    name: "gh_issue_create",
    description:
      "Broker-side gh issue create (credentialed). Creates an issue on the repo at cwd, or on --repo owner/name if given.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path to a directory (repo for context unless repo param is set)." },
        title: { type: "string", description: "Issue title (max 300 chars)." },
        body: { type: "string", description: "Issue body (max 20000 chars). Default empty." },
        repo: { type: "string", description: "Optional owner/name target instead of cwd's repo." },
      },
      required: ["cwd", "title"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "codex_task":
        return await handleTask(args);
      case "codex_start":
        return await handleStart(args);
      case "codex_status":
        return handleStatus(args);
      case "codex_result":
        return handleResult(args);
      case "codex_cancel":
        return handleCancel(args);
      case "codex_review":
        return await handleReview(args);
      case "codex_resume":
        return await handleResume(args);
      case "git_push":
        return await handleGitPush(args);
      case "git_pull":
        return await handleGitPull(args);
      case "gh_repo_create":
        return await handleGhRepoCreate(args);
      case "git_commit":
        return await handleGitCommit(args);
      case "git_clone":
        return await handleGitClone(args);
      case "gh_read":
        return await handleGhRead(args);
      case "gh_pr_create":
        return await handleGhPrCreate(args);
      case "gh_issue_create":
        return await handleGhIssueCreate(args);
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    if (err instanceof ValidationError) return textResult(`Invalid request: ${err.message}`, true);
    return textResult(`Broker error in ${name}: ${err && err.stack ? err.stack : err}`, true);
  }
});

// ---- Handlers -------------------------------------------------------------

async function handleTask(args) {
  const prompt = requireString(args.prompt, "prompt");
  const cwd = validateCwd(args.cwd);
  const sandbox = validateSandbox(args.sandbox);
  const network = args.network === true;
  const model = resolveModel(args.model);
  const timeoutSeconds = clampTimeoutSeconds(args.timeout_seconds, DEFAULT_TASK_TIMEOUT);

  // DIRECT spawn (no detached runner) — see lib/jobs.mjs.
  const { jobId, done } = runSyncJob({
    jobClass: "task",
    builder: (lastMessageFile) => buildTaskArgs({ sandbox, model, lastMessageFile, network }),
    cwd,
    promptText: prompt,
    model,
    sandbox,
    bin: resolveCodexBinary(),
    timeoutMs: timeoutSeconds * 1000,
  });
  const { timedOut } = await done;
  const job = readJob(jobId);
  return renderSyncOutcome("codex_task", { ...job, job_id: jobId }, { timedOut, timeoutSeconds });
}

async function handleStart(args) {
  const prompt = requireString(args.prompt, "prompt");
  const cwd = validateCwd(args.cwd);
  const sandbox = validateSandbox(args.sandbox);
  const network = args.network === true;
  const model = resolveModel(args.model);

  const jobId = startJob({
    jobClass: "task",
    builder: (lastMessageFile) => buildTaskArgs({ sandbox, model, lastMessageFile, network }),
    cwd,
    promptText: prompt,
    model,
    sandbox,
    extra: { bin: resolveCodexBinary() },
  });
  return textResult(
    [
      `Started background job.`,
      `job_id: ${jobId}`,
      `Poll with codex_status({job_id:"${jobId}"}) and fetch with codex_result({job_id:"${jobId}"}).`,
    ].join("\n")
  );
}

function handleStatus(args) {
  const jobId = requireString(args.job_id, "job_id");
  if (!jobExists(jobId)) return textResult(`No such job_id: ${jobId}`, true);
  const job = readJob(jobId);
  if (!job) return textResult(`No such job_id: ${jobId}`, true);
  const lines = [
    `job_id: ${jobId}`,
    `class: ${job.meta.jobClass}`,
    `status: ${job.status}${job.reason ? ` (${job.reason})` : ""}`,
    `runtime: ${job.runtimeSeconds}s`,
    sessionLine(job.sessionId),
    ``,
    `Last output lines:`,
    lastLines(job.logText, 20) || "(no output yet)",
  ];
  return textResult(lines.join("\n"), false);
}

function handleResult(args) {
  const jobId = requireString(args.job_id, "job_id");
  if (!jobExists(jobId)) return textResult(`No such job_id: ${jobId}`, true);
  const job = readJob(jobId);
  if (!job) return textResult(`No such job_id: ${jobId}`, true);
  if (job.status === "running") {
    return textResult(
      `Job ${jobId} is still running (runtime ${job.runtimeSeconds}s). ` +
        `Poll codex_status until it is completed/failed, or codex_cancel to stop it.`,
      true
    );
  }
  const lines = [
    `job_id: ${jobId}`,
    `status: ${job.status}${job.reason ? ` (${job.reason})` : ""}`,
    `exit: ${job.exitCode ?? "n/a"}`,
    `runtime: ${job.runtimeSeconds}s`,
    sessionLine(job.sessionId),
    ``,
    job.finalMessage || lastLines(job.logText, 20) || "(no final message)",
  ];
  return textResult(lines.join("\n"), job.status !== "completed");
}

function handleCancel(args) {
  const jobId = requireString(args.job_id, "job_id");
  if (!jobExists(jobId)) return textResult(`No such job_id: ${jobId}`, true);
  const res = cancelJob(jobId);
  if (res.alreadyEnded) {
    return textResult(`Job ${jobId} already ended with status "${res.status}"; nothing to cancel.`);
  }
  return textResult(`Canceled job ${jobId}; process tree killed.`);
}

async function handleReview(args) {
  const cwd = validateCwd(args.cwd);
  const model = resolveModel(args.model);
  const focus = typeof args.focus === "string" && args.focus.trim() !== "" ? args.focus : null;
  const background = args.background === true;
  const timeoutSeconds = clampTimeoutSeconds(args.timeout_seconds, DEFAULT_REVIEW_TIMEOUT);
  const builder = (lastMessageFile) => buildReviewArgs({ model, hasFocus: !!focus, lastMessageFile });

  if (background) {
    const jobId = startJob({
      jobClass: "review",
      builder,
      cwd,
      promptText: focus ?? "",
      model,
      sandbox: "read-only",
      extra: { bin: resolveCodexBinary() },
    });
    return textResult(
      [
        `Started background review job.`,
        `job_id: ${jobId}`,
        `Poll with codex_status and fetch with codex_result.`,
      ].join("\n")
    );
  }

  // DIRECT spawn for the synchronous path.
  const { jobId, done } = runSyncJob({
    jobClass: "review",
    builder,
    cwd,
    promptText: focus ?? "",
    model,
    sandbox: "read-only",
    bin: resolveCodexBinary(),
    timeoutMs: timeoutSeconds * 1000,
  });
  const { timedOut } = await done;
  const job = readJob(jobId);
  return renderSyncOutcome("codex_review", { ...job, job_id: jobId }, { timedOut, timeoutSeconds });
}

async function handleResume(args) {
  const sessionId = requireString(args.thread_id ?? args.session_id, "thread_id");
  const prompt = requireString(args.prompt, "prompt");
  const cwd = validateCwd(args.cwd);
  const model = resolveModel(args.model);
  const timeoutSeconds = clampTimeoutSeconds(args.timeout_seconds, DEFAULT_TASK_TIMEOUT);

  // DIRECT spawn (no detached runner) — see lib/jobs.mjs.
  const { jobId, done } = runSyncJob({
    jobClass: "resume",
    builder: (lastMessageFile) => buildResumeArgs({ sessionId, model, lastMessageFile }),
    cwd,
    promptText: prompt,
    model,
    sandbox: null,
    bin: resolveCodexBinary(),
    timeoutMs: timeoutSeconds * 1000,
  });
  const { timedOut } = await done;
  const job = readJob(jobId);
  return renderSyncOutcome("codex_resume", { ...job, job_id: jobId }, { timedOut, timeoutSeconds });
}

// ---- Boot -----------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the JSON-RPC channel).
  let binInfo;
  try {
    binInfo = resolveCodexBinary();
  } catch (e) {
    binInfo = `<unresolved: ${e.message}>`;
  }
  process.stderr.write(`codex-broker MCP server running (codex bin: ${binInfo})\n`);
}

main().catch((err) => {
  process.stderr.write(`codex-broker failed to start: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});


// ---- Broker-side git/gh handlers (unsandboxed, deliberately narrow) --------

function renderPlain(label, r) {
  const out = truncate(r.output);
  return textResult(`${label}: ${r.ok ? "OK" : `FAILED (exit ${r.code})`}\n\n${out}`, !r.ok);
}

async function handleGitPush(args) {
  const cwd = validateCwd(args.cwd);
  const branch = validateRefName(args.branch, "branch");
  const remote = validateRefName(args.remote, "remote", "origin");
  const setUpstream = args.set_upstream !== false;
  const argv = ["push"];
  if (setUpstream) argv.push("-u");
  argv.push(remote, branch);
  const r = await runPlainCommand({ jobClass: "git", bin: resolveGitBinary(), argv, cwd, timeoutMs: 120000 });
  return renderPlain(`git push ${remote} ${branch}`, r);
}

async function handleGitPull(args) {
  const cwd = validateCwd(args.cwd);
  const remote = validateRefName(args.remote, "remote", "origin");
  const argv = ["pull", "--ff-only", remote];
  if (args.branch) argv.push(validateRefName(args.branch, "branch"));
  const r = await runPlainCommand({ jobClass: "git", bin: resolveGitBinary(), argv, cwd, timeoutMs: 120000 });
  return renderPlain(`git pull --ff-only`, r);
}

async function handleGhRepoCreate(args) {
  const cwd = validateCwd(args.cwd);
  const rawName = requireString(args.name, "name");
  // allow owner/name or bare name
  const parts = rawName.split("/");
  if (parts.length > 2) throw new ValidationError(`Invalid repo name: ${rawName}`);
  for (const p of parts) validateRepoName(p);
  const visibility = args.visibility === "private" ? "--private" : "--public";
  const argv = ["repo", "create", rawName, visibility, "--source", ".", "--push"];
  const r = await runPlainCommand({ jobClass: "gh", bin: resolveGhBinary(), argv, cwd, timeoutMs: 120000 });
  return renderPlain(`gh repo create ${rawName}`, r);
}

// ---- v1.5.0 handlers -------------------------------------------------------

async function handleGitCommit(args) {
  const cwd = validateCwd(args.cwd);
  const message = validateCommitMessage(args.message);
  const git = resolveGitBinary();

  let addArgv;
  if (Array.isArray(args.paths) && args.paths.length > 0) {
    const specs = args.paths.map(validatePathspec);
    addArgv = ["add", "--", ...specs];
  } else {
    addArgv = ["add", "-A"];
  }
  const add = await runPlainCommand({ jobClass: "git", bin: git, argv: addArgv, cwd, timeoutMs: 120000 });
  if (!add.ok) return renderPlain("git add", add);

  const commit = await runPlainCommand({
    jobClass: "git",
    bin: git,
    argv: ["commit", "-m", message],
    cwd,
    timeoutMs: 120000,
  });
  if (!commit.ok) return renderPlain("git commit", commit);

  const show = await runPlainCommand({
    jobClass: "git",
    bin: git,
    argv: ["show", "--stat", "--format=%H %s", "HEAD"],
    cwd,
    timeoutMs: 60000,
  });
  return renderPlain("git commit", { ok: true, code: 0, output: `${commit.output}\n${show.output}` });
}

async function handleGitClone(args) {
  const url = validateHttpsGitUrl(args.url);
  const dest = validateNewDirPath(args.dest, "dest");
  const argv = ["clone", url, dest];
  if (args.branch) {
    argv.push("-b", validateRefName(args.branch, "branch"));
  }
  // cwd = dest's parent (validated to exist by validateNewDirPath).
  const parent = path.dirname(dest);
  const r = await runPlainCommand({ jobClass: "git", bin: resolveGitBinary(), argv, cwd: parent, timeoutMs: 300000 });
  return renderPlain(`git clone -> ${dest}`, r);
}

async function handleGhRead(args) {
  const argv = validateGhReadArgs(args.args);
  const cwd = args.cwd ? validateCwd(args.cwd) : process.env.HOME || process.env.USERPROFILE || ".";
  const r = await runPlainCommand({ jobClass: "gh", bin: resolveGhBinary(), argv, cwd, timeoutMs: 120000 });
  return renderPlain(`gh ${argv[0]} ${argv[1]}`, r);
}

async function handleGhPrCreate(args) {
  const cwd = validateCwd(args.cwd);
  const title = validateTextField(args.title, "title", 300);
  const body = validateTextField(args.body, "body", 20000, { required: false });
  const argv = ["pr", "create", "--title", title, "--body", body];
  if (args.base) argv.push("--base", validateRefName(args.base, "base"));
  if (args.head) argv.push("--head", validateRefName(args.head, "head"));
  if (args.draft === true) argv.push("--draft");
  const r = await runPlainCommand({ jobClass: "gh", bin: resolveGhBinary(), argv, cwd, timeoutMs: 120000 });
  return renderPlain("gh pr create", r);
}

async function handleGhIssueCreate(args) {
  const cwd = validateCwd(args.cwd);
  const title = validateTextField(args.title, "title", 300);
  const body = validateTextField(args.body, "body", 20000, { required: false });
  const argv = ["issue", "create", "--title", title, "--body", body];
  if (args.repo) argv.push("--repo", validateOwnerRepo(args.repo));
  const r = await runPlainCommand({ jobClass: "gh", bin: resolveGhBinary(), argv, cwd, timeoutMs: 120000 });
  return renderPlain("gh issue create", r);
}
