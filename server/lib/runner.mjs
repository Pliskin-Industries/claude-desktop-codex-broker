#!/usr/bin/env node
// Detached background runner: launched by the broker (as a process-group
// leader) ONLY for background jobs (codex_start / codex_review background:true).
// It runs the actual codex process and records the exit status to disk. Because
// it is detached and unref'd, it (and its codex child) survive a broker
// crash/restart. All communication with the broker is via files in the job dir.
//
// The runner's own stdout/stderr are captured by the broker into
// runner-boot.log, and every failure path here appends a diagnostic to
// output.log and writes an exit marker, so a silent death always leaves a
// trace (learned from a Windows/Electron-host field failure where the old
// runner died with a 0-byte log and no exit file).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveCodexBinary, spawnFailureMessage } from "./util.mjs";

const jobDir = process.argv[2];

// Boot breadcrumbs go to stderr (captured into runner-boot.log by the broker).
function boot(msg) {
  try {
    process.stderr.write(`[runner-boot] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

boot(
  `runner started; execPath=${process.execPath}; ` +
    `ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? "<unset>"}; jobDir=${jobDir}`
);

// Resolve output.log / exit early so the global handlers can always write there.
let outputLog = jobDir ? path.join(jobDir, "output.log") : null;
let exitFile = jobDir ? path.join(jobDir, "exit") : null;

function appendOutput(text) {
  if (!outputLog) return;
  try {
    fs.appendFileSync(outputLog, text.endsWith("\n") ? text : text + "\n");
  } catch {
    /* ignore */
  }
}
function writeExitIfAbsent(value) {
  if (!exitFile) return;
  try {
    if (!fs.existsSync(exitFile)) fs.writeFileSync(exitFile, String(value));
  } catch {
    /* ignore */
  }
}

process.on("uncaughtException", (err) => {
  boot(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  appendOutput(`[broker-runner] uncaughtException: ${err && err.stack ? err.stack : err}`);
  writeExitIfAbsent(-1);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  boot(`unhandledRejection: ${reason}`);
  appendOutput(`[broker-runner] unhandledRejection: ${reason}`);
  writeExitIfAbsent(-1);
  process.exit(1);
});

function main() {
  if (!jobDir) {
    boot("no jobDir argument supplied");
    process.exit(2);
  }

  const command = JSON.parse(fs.readFileSync(path.join(jobDir, "command.json"), "utf8"));
  const bin = command.bin || resolveCodexBinary();
  outputLog = command.outputLog || outputLog;
  exitFile = command.exitFile || exitFile;
  const metaFile = command.metaFile || path.join(jobDir, "meta.json");

  const logFd = fs.openSync(outputLog, "a");
  appendOutput(`[broker-runner] runner alive, spawning ${bin} (execPath=${process.execPath})`);

  let promptFd;
  try {
    promptFd = fs.openSync(command.promptFile, "r");
  } catch {
    promptFd = "ignore";
  }

  const env = command.env ? { ...process.env, ...command.env } : process.env;

  let child;
  try {
    child = spawn(bin, command.argv, {
      cwd: command.cwd,
      stdio: [promptFd, logFd, logFd],
      env,
      windowsHide: true,
    });
  } catch (err) {
    boot(`spawn threw: ${err && err.message}`);
    appendOutput(`[broker-runner] ${spawnFailureMessage(bin, err)}`);
    writeExitIfAbsent(127);
    process.exit(0);
  }

  // Record the codex child pid for observability.
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    meta.codexPid = child.pid;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch {
    /* ignore */
  }

  child.on("error", (err) => {
    boot(`codex 'error' event: ${err && err.message}`);
    appendOutput(`[broker-runner] ${spawnFailureMessage(bin, err)}`);
    writeExitIfAbsent(127);
    process.exit(0);
  });

  child.on("exit", (code, signal) => {
    const value = code != null ? String(code) : signal ? `signal:${signal}` : "1";
    writeExitIfAbsent(value);
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      meta.endedAt = new Date().toISOString();
      meta.exitCode = value;
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    } catch {
      /* ignore */
    }
    boot(`codex exited code=${code} signal=${signal}`);
    process.exit(0);
  });
}

try {
  main();
} catch (err) {
  boot(`main threw: ${err && err.stack ? err.stack : err}`);
  appendOutput(`[broker-runner] fatal: ${err && err.stack ? err.stack : err}`);
  writeExitIfAbsent(-1);
  process.exit(1);
}
