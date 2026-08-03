// Job lifecycle, persisted under $CODEX_BROKER_HOME/jobs/<job_id>/.
// Each job dir contains:
//   meta.json         static info + flags (mode/canceled/timedOut/pid)
//   prompt.txt        prompt/focus text (fed to codex via stdin)
//   output.log        combined stdout+stderr of codex (+ diagnostics)
//   last-message.txt  codex --output-last-message target
//   exit              exit code / marker, written when codex finishes
//
// BOTH execution modes spawn codex.exe DIRECTLY from the broker process —
// there is never an intermediate node/runner respawn. This is deliberate: under
// a Claude Desktop MCPB (Electron) host, process.execPath is the Claude app
// binary, and on some builds (e.g. the MS Store package) the ELECTRON_RUN_AS_NODE
// fuse is burned, so respawning process.execPath ALWAYS launches the GUI app —
// there is no way to get a node runtime out of it. (v1.3.x used a detached
// lib/runner.mjs for background jobs; v1.4.0 removed it for this reason.)
//
//   * DIRECT (mode:"direct")  — synchronous tools (codex_task, synchronous
//     codex_review, codex_resume). Spawn codex, wait for it, return the result.
//   * BACKGROUND (mode:"background") — codex_start and
//     codex_review(background:true). Spawn codex unref'd (detached on POSIX
//     only — see the spawn-site comment for why detached must stay false on
//     Windows), return the job_id immediately; exit/error handlers in the
//     broker record completion to disk. Tradeoff vs the old runner model: if the broker process itself
//     restarts mid-job, the in-flight job may be orphaned (its exit status is
//     never recorded, surfacing as "process exited without recording status")
//     — completed-job results still persist on disk.
//
// Status/results are always re-derived from disk; liveness is checked via pid.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildGitConfigEnv, jobsDir, spawnFailureMessage } from "./util.mjs";
import { extractResult } from "./codex.mjs";

const IS_WINDOWS = process.platform === "win32";

function generateJobId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

function jobPath(jobId, ...rest) {
  return path.join(jobsDir(), jobId, ...rest);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function appendLog(file, text) {
  try {
    fs.appendFileSync(file, text.endsWith("\n") ? text : text + "\n");
  } catch {
    /* ignore */
  }
}

function writeExitIfAbsent(exitFile, value) {
  try {
    if (!fs.existsSync(exitFile)) fs.writeFileSync(exitFile, String(value));
  } catch {
    /* ignore */
  }
}

function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours to signal
  }
}

// Kill a process and its children, cross-platform. On Windows there are no
// POSIX process groups, so use taskkill /T to walk the tree; elsewhere signal
// the negative pid (the process group created via detached:true).
export function killTree(pid) {
  if (!pid || Number.isNaN(pid)) return;
  if (IS_WINDOWS) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// Create the on-disk job directory and artifacts common to both modes. Returns
// the resolved paths, argv, and a base meta object (pid/mode filled in by the
// caller).
function createJobArtifacts({ jobClass, builder, cwd, promptText, model, sandbox, bin }) {
  const jobId = generateJobId();
  const dir = jobPath(jobId);
  fs.mkdirSync(dir, { recursive: true });

  const promptFile = path.join(dir, "prompt.txt");
  const lastMessageFile = path.join(dir, "last-message.txt");
  const outputLog = path.join(dir, "output.log");
  const exitFile = path.join(dir, "exit");
  const metaFile = path.join(dir, "meta.json");

  const argv = builder(lastMessageFile);

  fs.writeFileSync(promptFile, promptText ?? "");
  fs.writeFileSync(outputLog, "");

  const meta = {
    job_id: jobId,
    jobClass,
    mode: null, // set by caller: "direct" | "background"
    pid: null, // set by caller
    bin,
    argv,
    cwd,
    model: model ?? null,
    sandbox: sandbox ?? null,
    lastMessageFile,
    outputLog,
    exitFile,
    promptPreview: (promptText ?? "").slice(0, 200),
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    canceled: false,
    timedOut: false,
  };

  return { jobId, dir, promptFile, lastMessageFile, outputLog, exitFile, metaFile, argv, meta };
}

function writeMeta(metaFile, meta) {
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
}

// DIRECT synchronous execution: spawn codex.exe directly from the server and
// wait. Returns { jobId, done } where `done` resolves with { timedOut } once
// the child exits, errors, or is killed on timeout. All the usual job-dir
// artifacts are written for auditability.
export function runSyncJob({ jobClass, builder, cwd, promptText, model, sandbox, bin, timeoutMs }) {
  const a = createJobArtifacts({ jobClass, builder, cwd, promptText, model, sandbox, bin });
  a.meta.mode = "direct";
  writeMeta(a.metaFile, a.meta);

  const logFd = fs.openSync(a.outputLog, "a");
  appendLog(a.outputLog, `[broker] direct spawn of "${bin}" (mode=direct) at ${new Date().toISOString()}`);

  let child;
  try {
    child = spawn(bin, a.argv, {
      cwd,
      // detached => own process group on POSIX (for killTree via -pid). On
      // Windows we rely on taskkill /T and avoid a new console window.
      detached: !IS_WINDOWS,
      stdio: ["pipe", logFd, logFd],
      env: { ...process.env },
      windowsHide: true,
    });
  } catch (err) {
    appendLog(a.outputLog, `[broker] ${spawnFailureMessage(bin, err)}`);
    writeExitIfAbsent(a.exitFile, "127");
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    return { jobId: a.jobId, done: Promise.resolve({ timedOut: false }) };
  }

  a.meta.pid = child.pid;
  writeMeta(a.metaFile, a.meta);

  // Feed the prompt via stdin. Guard against EPIPE if the child dies instantly
  // (Windows especially) so it can never crash the parent silently.
  try {
    child.stdin.on("error", () => {
      /* swallow EPIPE/ECONNRESET from an instantly-dead child */
    });
    child.stdin.write(promptText ?? "");
    child.stdin.end();
  } catch {
    /* ignore */
  }

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      killTree(child.pid);
      const meta = readJsonSafe(a.metaFile) || a.meta;
      meta.timedOut = true;
      meta.endedAt = new Date().toISOString();
      writeMeta(a.metaFile, meta);
      writeExitIfAbsent(a.exitFile, "timeout");
      appendLog(a.outputLog, `[broker] killed after timeout (${Math.round(timeoutMs / 1000)}s)`);
      finish({ timedOut: true });
    }, timeoutMs);

    child.on("error", (err) => {
      appendLog(a.outputLog, `[broker] ${spawnFailureMessage(bin, err)}`);
      writeExitIfAbsent(a.exitFile, "127");
      finish({ timedOut: false });
    });

    child.on("exit", (code, signal) => {
      const value = code != null ? String(code) : signal ? `signal:${signal}` : "1";
      writeExitIfAbsent(a.exitFile, value);
      const meta = readJsonSafe(a.metaFile) || a.meta;
      meta.endedAt = new Date().toISOString();
      meta.exitCode = value;
      writeMeta(a.metaFile, meta);
      finish({ timedOut: false });
    });
  });

  return { jobId: a.jobId, done };
}

// BACKGROUND execution: spawn codex.exe DIRECTLY from the broker (exactly like
// the sync path — never an intermediate node/runner respawn, which an Electron
// host with the ELECTRON_RUN_AS_NODE fuse burned would turn into a GUI app
// launch). Do not await completion: the child is detached + unref'd so it does
// not hold the broker open, and exit/error handlers record the exit file,
// output.log diagnostics, and meta updates. The prompt is fed from prompt.txt
// via an inherited read fd, so the broker keeps no pipe to the child.
//
// Tradeoff (documented in README): the completion handlers live in THIS broker
// process, so a broker restart mid-job may orphan or kill an in-flight job (no
// exit file is ever written → codex_status reports "process exited without
// recording status" once the pid is gone). Completed-job results still persist
// on disk and remain readable via codex_status / codex_result.
export function startJob({ jobClass, builder, cwd, promptText, model, sandbox, extra = {} }) {
  const bin = extra.bin;
  const a = createJobArtifacts({ jobClass, builder, cwd, promptText, model, sandbox, bin });
  a.meta.mode = "background";
  writeMeta(a.metaFile, a.meta);

  const logFd = fs.openSync(a.outputLog, "a");
  appendLog(a.outputLog, `[broker] direct spawn of "${bin}" (mode=background) at ${new Date().toISOString()}`);

  // Feed the prompt from the already-written prompt.txt as the child's stdin.
  let promptFd = "ignore";
  try {
    promptFd = fs.openSync(a.promptFile, "r");
  } catch {
    /* fall back to no stdin */
  }

  const env = extra.env ? { ...process.env, ...extra.env } : { ...process.env };

  let child;
  try {
    child = spawn(bin, a.argv, {
      cwd,
      // detached => own process group on POSIX (for killTree via -pid). On
      // Windows detached MUST stay false (matching the sync path): detached
      // launches codex with DETACHED_PROCESS — no console at all — so every
      // console child codex spawns (powershell per command) allocates a fresh
      // VISIBLE console window, one flash per command (v1.4.0 regression).
      // With detached:false + windowsHide, codex gets a hidden console its
      // children inherit silently. taskkill /T handles tree-kill, and unref()
      // works without detached, so nothing else is lost on Windows.
      detached: !IS_WINDOWS,
      stdio: [promptFd, logFd, logFd],
      env,
      windowsHide: true,
    });
  } catch (err) {
    appendLog(a.outputLog, `[broker] ${spawnFailureMessage(bin, err)}`);
    writeExitIfAbsent(a.exitFile, "127");
    closeFds(logFd, promptFd);
    return a.jobId;
  }

  child.on("error", (err) => {
    appendLog(a.outputLog, `[broker] ${spawnFailureMessage(bin, err)}`);
    writeExitIfAbsent(a.exitFile, "127");
    const meta = readJsonSafe(a.metaFile) || a.meta;
    meta.endedAt = new Date().toISOString();
    writeMeta(a.metaFile, meta);
  });

  child.on("exit", (code, signal) => {
    const value = code != null ? String(code) : signal ? `signal:${signal}` : "1";
    writeExitIfAbsent(a.exitFile, value);
    const meta = readJsonSafe(a.metaFile) || a.meta;
    meta.endedAt = new Date().toISOString();
    meta.exitCode = value;
    writeMeta(a.metaFile, meta);
  });

  // The child inherited dups of these fds; close the broker's copies so the
  // only open handles belong to the child.
  closeFds(logFd, promptFd);

  child.unref(); // never hold the broker's event loop open for a background job

  a.meta.pid = child.pid; // the codex process itself (process-group leader)
  writeMeta(a.metaFile, a.meta);
  return a.jobId;
}

function closeFds(...fds) {
  for (const fd of fds) {
    if (typeof fd !== "number") continue;
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

export function jobExists(jobId) {
  return typeof jobId === "string" && jobId !== "" && fs.existsSync(jobPath(jobId, "meta.json"));
}

// Derive current job state purely from disk + pid liveness.
export function readJob(jobId) {
  const metaFile = jobPath(jobId, "meta.json");
  const meta = readJsonSafe(metaFile);
  if (!meta) return null;

  const exitFile = jobPath(jobId, "exit");
  const hasExit = fs.existsSync(exitFile);
  let exitRaw = null;
  let endedAtMs = null;
  if (hasExit) {
    exitRaw = fs.readFileSync(exitFile, "utf8").trim();
    try {
      endedAtMs = fs.statSync(exitFile).mtimeMs;
    } catch {
      endedAtMs = Date.now();
    }
  }

  const alive = pidAlive(meta.pid);

  let status;
  let reason = null;
  if (meta.canceled) {
    status = "failed";
    reason = "canceled";
  } else if (meta.timedOut) {
    status = "failed";
    reason = "timeout";
  } else if (hasExit) {
    status = exitRaw === "0" ? "completed" : "failed";
    if (status === "failed") reason = `exit ${exitRaw}`;
  } else if (alive) {
    status = "running";
  } else {
    // No exit file and the process is gone -> it died before recording status.
    status = "failed";
    reason = "process exited without recording status";
  }

  const runtimeMs = (endedAtMs ?? Date.now()) - meta.startedAt;

  let logText = "";
  try {
    logText = fs.readFileSync(meta.outputLog, "utf8");
  } catch {
    /* ignore */
  }
  const { finalMessage, sessionId } = extractResult({
    logText,
    lastMessageFile: meta.lastMessageFile,
  });

  return {
    meta,
    status,
    reason,
    exitCode: exitRaw,
    runtimeSeconds: Math.max(0, Math.round(runtimeMs / 1000)),
    logText,
    finalMessage,
    sessionId,
  };
}

// Cancel a job: kill its process tree and mark it canceled (idempotent; only
// marks running jobs).
export function cancelJob(jobId) {
  const job = readJob(jobId);
  if (!job) return { found: false };
  if (job.status !== "running") {
    return { found: true, alreadyEnded: true, status: job.status };
  }
  killTree(job.meta.pid);
  const metaFile = jobPath(jobId, "meta.json");
  const meta = readJsonSafe(metaFile) || job.meta;
  meta.canceled = true;
  writeMeta(metaFile, meta);
  writeExitIfAbsent(jobPath(jobId, "exit"), "canceled");
  return { found: true, alreadyEnded: false, status: "failed" };
}

// Poll for a BACKGROUND job to finish, up to timeoutMs. On timeout, kill the
// tree, mark meta.timedOut, and return the (partial) job state. (The direct
// sync path uses runSyncJob's own waiter, not this.)
export async function waitForJob(jobId, timeoutMs, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = readJob(jobId);
    if (!job) return { job: null, timedOut: false };
    if (job.status !== "running") return { job, timedOut: false };
    if (Date.now() >= deadline) {
      killTree(job.meta.pid);
      const metaFile = jobPath(jobId, "meta.json");
      const meta = readJsonSafe(metaFile) || job.meta;
      meta.timedOut = true;
      writeMeta(metaFile, meta);
      writeExitIfAbsent(jobPath(jobId, "exit"), "timeout");
      await sleep(150);
      return { job: readJob(jobId), timedOut: true };
    }
    await sleep(pollMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Plain broker-side command (git/gh) — runs UNSANDBOXED, so it is kept
// deliberately narrow: fixed argv built by the caller from validated pieces,
// no shell, no force flags, prompt-free stdin.
export function runPlainCommand({ jobClass, bin, argv, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const chunks = [];
    let child;
    try {
      child = spawn(bin, argv, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Scope a git safe.directory exception to exactly this cwd via env
        // (works for git directly and for git invoked by gh), preserving any
        // GIT_CONFIG_* the host already set. See buildGitConfigEnv.
        env: buildGitConfigEnv(process.env, cwd),
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, code: 127, output: spawnFailureMessage(bin, err) });
      return;
    }
    const timer = setTimeout(() => {
      try { killTree(child.pid); } catch { /* ignore */ }
      resolve({ ok: false, code: -1, output: Buffer.concat(chunks).toString("utf8") + "\n[broker] TIMEOUT: killed after " + timeoutMs + "ms" });
    }, timeoutMs);
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 127, output: spawnFailureMessage(bin, err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
