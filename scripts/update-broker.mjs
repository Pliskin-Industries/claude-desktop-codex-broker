#!/usr/bin/env node
// Update the broker checkout and restart Claude Desktop so the new code (and a
// fresh PATH) is live, without a trip to Task Manager.
//
//   node scripts/update-broker.mjs                 # pull, deps if needed, test, restart
//   node scripts/update-broker.mjs --restart-only  # just restart Claude Desktop
//   node scripts/update-broker.mjs --no-restart    # update and test, restart later
//   node scripts/update-broker.mjs --dry-run       # show what would happen; change nothing
//   node scripts/update-broker.mjs --skip-tests    # skip the test gate (not recommended)
//
// Why a script: the extension's server process never restarts on its own
// (docs/LESSONS.md #3), a tray quit does not always end every Claude process,
// and a process keeps the PATH it started with, so tools installed after the
// app started stay invisible to the broker until a real restart.
//
// The restart runs in a helper created through WMI (Win32_Process.Create), so
// it is not a child of Claude and survives Claude exiting. That is what lets
// this script be run from inside a Claude session: the session ends, the
// helper finishes the restart, and you reopen the session. The helper logs to
// <tmp>/codex-broker-restart.log.
//
// Only Claude Desktop's own processes are stopped: executables under the app's
// install directory and the desktop-managed Claude Code under %APPDATA%\Claude.
// A standalone Claude Code CLI in a terminal is left alone. The app is
// relaunched through Explorer, so it gets the shell's current environment.
//
// Windows only for the restart. Verified on the Microsoft Store build; the
// %LOCALAPPDATA%\AnthropicClaude (direct download) layout is handled but
// untested.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SELF = fileURLToPath(import.meta.url);
const DEP_FILES = ["server/package.json", "server/package-lock.json"];

export function parseArgs(argv) {
  const opts = { pull: true, tests: true, restart: true, dryRun: false, helper: false };
  for (const a of argv) {
    if (a === "--no-pull") opts.pull = false;
    else if (a === "--skip-tests") opts.tests = false;
    else if (a === "--no-restart") opts.restart = false;
    else if (a === "--restart-only") Object.assign(opts, { pull: false, tests: false, restart: true });
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--restart-helper") opts.helper = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

// Reinstall server deps when the pull touched them or they were never installed.
export function needsDepsInstall(changedFiles, nodeModulesExists) {
  if (!nodeModulesExists) return true;
  const norm = changedFiles.map((f) => f.replace(/\\/g, "/"));
  return DEP_FILES.some((f) => norm.includes(f));
}

// Decide how to relaunch Claude Desktop and which install directories belong
// to it. startApps is Get-StartApps output ([{Name, AppID}]).
export function pickLaunchTarget({ startApps, env, exists }) {
  const store = (startApps || []).find((a) => a.Name === "Claude" && /^Claude_[a-z0-9]+!/i.test(a.AppID || ""));
  if (store) {
    const family = store.AppID.split("!")[0];
    return {
      kind: "store",
      launch: ["explorer.exe", `shell:AppsFolder\\${store.AppID}`],
      appDirs: [`${env.ProgramFiles || "C:\\Program Files"}\\WindowsApps\\${family.replace(/_([a-z0-9]+)$/i, "_")}`],
      family,
    };
  }
  const direct = env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "AnthropicClaude") : null;
  if (direct && exists(path.win32.join(direct, "claude.exe"))) {
    return { kind: "direct", launch: ["explorer.exe", path.win32.join(direct, "claude.exe")], appDirs: [direct] };
  }
  return null;
}

// Claude Desktop's processes: the app itself, plus the desktop-managed Claude
// Code sessions it spawns. For the Store build appDirs holds a prefix
// ("...\WindowsApps\Claude_") that matches every installed version, with the
// publisher suffix checked separately.
export function selectAppProcesses(procs, { target, env }) {
  const lower = (s) => (s || "").toLowerCase();
  const managedCode = env.APPDATA ? lower(path.win32.join(env.APPDATA, "Claude", "claude-code")) + "\\" : null;
  const suffix = target.kind === "store" ? lower(target.family.split("_").pop()) : null;
  return procs.filter((p) => {
    const exe = lower(p.ExecutablePath);
    if (!exe) return false;
    if (managedCode && exe.startsWith(managedCode)) return true;
    return target.appDirs.some((d) => {
      const dir = lower(d);
      if (!exe.startsWith(dir)) return false;
      if (target.kind !== "store") return exe.charAt(dir.length) === "\\";
      // ...\WindowsApps\Claude_<version>_x64__<publisher>\...
      const pkg = exe.slice(dir.length).split("\\")[0];
      return pkg.endsWith(`__${suffix}`);
    });
  });
}

// The app's root processes: selected processes whose parent is not selected.
// Killing each root's tree takes the helpers down with it.
export function rootProcesses(selected) {
  const ids = new Set(selected.map((p) => p.ProcessId));
  return selected.filter((p) => !ids.has(p.ParentProcessId));
}

// --- side effects -------------------------------------------------------------

function run(cmd, args, { cwd = ROOT, shell = false, capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    shell,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (r.error) throw r.error;
  return r;
}

function powershell(script, env = process.env) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`powershell failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function psJson(script) {
  const out = powershell(`${script} | ConvertTo-Json -Compress`);
  if (!out) return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}

function claudeProcesses() {
  return psJson(
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath"
  );
}

function detectTarget() {
  const startApps = psJson("Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object Name,AppID");
  return pickLaunchTarget({ startApps, env: process.env, exists: fs.existsSync });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pull() {
  const head = () => run("git", ["rev-parse", "HEAD"], { capture: true }).stdout.trim();
  const before = head();
  const r = run("git", ["pull", "--ff-only"]);
  if (r.status !== 0) throw new Error("git pull --ff-only failed; resolve it in the checkout and re-run");
  const after = head();
  if (before === after) return { updated: false, changed: [] };
  const diff = run("git", ["diff", "--name-only", before, after], { capture: true }).stdout;
  return { updated: true, changed: diff.split(/\r?\n/).filter(Boolean), before, after };
}

// Spawn the restart helper outside Claude's process tree (WMI parents it to
// the WMI provider host, not to us), with its window hidden.
function launchHelper(logFile, dryRun) {
  const args = [process.execPath, SELF, "--restart-helper", ...(dryRun ? ["--dry-run"] : [])];
  const commandLine = args.map((a) => `"${a}"`).join(" ");
  powershell(
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 };" +
      "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ " +
      "CommandLine = $env:CB_HELPER_CMD; CurrentDirectory = $env:CB_HELPER_CWD; ProcessStartupInformation = $si };" +
      "if ($r.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($r.ReturnValue)\" }",
    { ...process.env, CB_HELPER_CMD: commandLine, CB_HELPER_CWD: ROOT, CB_RESTART_LOG: logFile }
  );
}

// Runs detached: stop Claude Desktop, wait for it to be gone, relaunch it.
function restartHelper(dryRun) {
  const logFile = path.join(os.tmpdir(), "codex-broker-restart.log");
  const log = (m) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  try {
    log(`helper start pid=${process.pid}${dryRun ? " (dry run)" : ""}`);
    sleep(1500); // let the invoking script print and exit
    const target = detectTarget();
    if (!target) throw new Error("Claude Desktop install not found (no Store app, no %LOCALAPPDATA%\\AnthropicClaude)");
    let procs = selectAppProcesses(claudeProcesses(), { target, env: process.env });
    const roots = rootProcesses(procs);
    log(`target=${target.kind} launch=${target.launch.join(" ")} processes=${procs.length} roots=${roots.map((p) => p.ProcessId).join(",")}`);
    if (dryRun) {
      log("dry run: nothing stopped or launched");
      return;
    }
    for (const p of roots) run("taskkill.exe", ["/PID", String(p.ProcessId), "/T", "/F"], { capture: true });
    for (let i = 0; i < 30; i++) {
      procs = selectAppProcesses(claudeProcesses(), { target, env: process.env });
      if (procs.length === 0) break;
      if (i === 10) for (const p of procs) run("taskkill.exe", ["/PID", String(p.ProcessId), "/T", "/F"], { capture: true });
      sleep(500);
    }
    if (procs.length) throw new Error(`still running after 15s: ${procs.map((p) => p.ProcessId).join(",")}`);
    log("all Claude Desktop processes stopped");
    run(target.launch[0], target.launch.slice(1), { capture: true }); // explorer's exit code is meaningless
    for (let i = 0; i < 40; i++) {
      sleep(500);
      if (selectAppProcesses(claudeProcesses(), { target, env: process.env }).length) {
        log("Claude Desktop relaunched");
        return;
      }
    }
    throw new Error("relaunch requested but no Claude process appeared within 20s; start Claude from the Start menu");
  } catch (e) {
    log(`ERROR ${e.message}`);
    process.exitCode = 1;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.helper) return restartHelper(opts.dryRun);

  if (opts.pull) {
    if (opts.dryRun) console.log("would run: git pull --ff-only");
    else {
      const r = pull();
      console.log(r.updated ? `pulled ${r.before.slice(0, 7)}..${r.after.slice(0, 7)} (${r.changed.length} files)` : "already up to date");
      if (needsDepsInstall(r.changed, fs.existsSync(path.join(ROOT, "server", "node_modules")))) {
        console.log("server dependencies changed: npm ci --prefix server");
        // npm is a .cmd shim on Windows, which Node only spawns through a shell.
        // Fixed arguments, no user input.
        if (run("npm", ["ci", "--prefix", "server"], { shell: process.platform === "win32" }).status !== 0) {
          throw new Error("npm ci failed; not restarting");
        }
      }
    }
  }

  if (opts.tests) {
    if (opts.dryRun) console.log("would run: node server/test/run-tests.mjs");
    else if (run(process.execPath, ["test/run-tests.mjs"], { cwd: path.join(ROOT, "server") }).status !== 0) {
      throw new Error("tests failed; not restarting. The running broker is unchanged until the next app restart.");
    }
  }

  if (!opts.restart) return;
  if (process.platform !== "win32") {
    console.log("restart: quit Claude Desktop completely and reopen it (automatic restart is Windows-only)");
    return;
  }
  const target = detectTarget();
  if (!target) throw new Error("Claude Desktop install not found; restart it by hand");
  const procs = selectAppProcesses(claudeProcesses(), { target, env: process.env });
  console.log(`Claude Desktop (${target.kind}): ${procs.length} process(es) to stop, relaunch via ${target.launch.join(" ")}`);
  const logFile = path.join(os.tmpdir(), "codex-broker-restart.log");
  if (process.env.CLAUDECODE) {
    console.log("Running inside a Claude session: this session will end with the app. Reopen it once Claude is back.");
  }
  launchHelper(logFile, opts.dryRun);
  console.log(`restart helper launched${opts.dryRun ? " (dry run, nothing will be stopped)" : ""}; log: ${logFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    main();
  } catch (e) {
    console.error(`update-broker: ${e.message}`);
    process.exit(2);
  }
}
