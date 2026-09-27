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
// app started stay invisible to the broker until a real restart (LESSONS #10).
//
// The restart runs in a helper created through WMI (Win32_Process.Create), so
// it is not a child of Claude and survives Claude exiting. That is what lets
// this script be run from inside a Claude session: the session ends, the
// helper finishes the restart, and you reopen the session.
//
// What gets stopped, and how:
// - Only the Claude Desktop package published by Anthropic (publisher id
//   pinned below) is trusted as the app to restart; a lookalike package named
//   Claude is refused.
// - Only processes whose executable lives in that package's install directory,
//   or in the desktop-managed Claude Code directory, are stopped. Each one is
//   stopped on its own, never as a process tree, so terminals, editors or
//   builds started from inside a Claude session keep running.
// - Each kill is bound to the process's identity: the PID is re-opened, and
//   the kill happens only if its start time and executable still match what
//   was selected, so a reused PID is never killed.
// - Once stopping has begun, any later failure still ends in an attempt to
//   relaunch the app.
//
// Windows only for the restart. Claude Desktop for Windows ships as MSIX
// packages only, so the launch target is the registered package.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SELF = fileURLToPath(import.meta.url);
const SERVER = path.join(ROOT, "server");
const DEPS_MARKER = path.join(SERVER, "node_modules", ".codex-broker-deps.json");

// PublisherId of the Claude Desktop MSIX package ("Anthropic, PBC"). Windows
// derives it from the signing certificate's subject, so another package can
// only carry it if signed with a certificate for that exact subject.
export const ANTHROPIC_PUBLISHER_ID = "pzs8sxrjxfjjc";

export function parseArgs(argv) {
  const opts = { pull: true, tests: true, restart: true, dryRun: false, helper: false, log: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-pull") opts.pull = false;
    else if (a === "--skip-tests") opts.tests = false;
    else if (a === "--no-restart") opts.restart = false;
    else if (a === "--restart-only") Object.assign(opts, { pull: false, tests: false, restart: true });
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--restart-helper") opts.helper = true;
    else if (a === "--log") {
      opts.log = argv[++i];
      if (!opts.log || !path.isAbsolute(opts.log)) throw new Error("--log needs an absolute path");
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

// Hash of what `npm ci` installs from. Recorded after a successful install, so
// a failed or interrupted install is retried on the next run instead of being
// forgotten once the pull that caused it is no longer in the diff.
export function depsHash(packageJson, packageLock) {
  return crypto.createHash("sha256").update(packageJson).update("\0").update(packageLock).digest("hex");
}

export function needsDepsInstall({ nodeModulesExists, currentHash, installedHash }) {
  return !nodeModulesExists || !installedHash || installedHash !== currentHash;
}

// Pick the Claude Desktop package to restart. packages is Get-AppxPackage
// output reduced to {Name, PublisherId, PackageFamilyName, InstallLocation,
// AppIds}. Only Anthropic's package qualifies, whatever else is named Claude.
export function pickLaunchTarget(packages) {
  const pkg = (packages || []).find(
    (p) => p.Name === "Claude" && p.PublisherId === ANTHROPIC_PUBLISHER_ID && p.InstallLocation && (p.AppIds || []).includes("Claude")
  );
  if (!pkg) return null;
  return {
    family: pkg.PackageFamilyName,
    installLocation: pkg.InstallLocation,
    launch: ["explorer.exe", `shell:AppsFolder\\${pkg.PackageFamilyName}!Claude`],
  };
}

// Claude Desktop's processes: executables in any installed version of
// Anthropic's Claude package (siblings of the current install directory,
// which covers a package moved to another drive and a version the app has
// updated past but is still running), plus the desktop-managed Claude Code.
export function selectAppProcesses(procs, { target, env }) {
  const lower = (s) => (s || "").toLowerCase();
  const parent = lower(path.win32.dirname(target.installLocation)) + "\\";
  const pkgDir = new RegExp(`^claude_[^\\\\]*__${ANTHROPIC_PUBLISHER_ID}$`);
  const managedCode = env.APPDATA ? lower(path.win32.join(env.APPDATA, "Claude", "claude-code")) + "\\" : null;
  return procs.filter((p) => {
    const exe = lower(p.ExecutablePath);
    if (!exe) return false;
    if (managedCode && exe.startsWith(managedCode)) return true;
    if (!exe.startsWith(parent)) return false;
    const rest = exe.slice(parent.length).split("\\");
    return rest.length > 1 && pkgDir.test(rest[0]);
  });
}

// Stop order: processes whose parent is not itself selected (the app's main
// process) first, then the rest. Each is still stopped individually.
export function stopOrder(selected) {
  const ids = new Set(selected.map((p) => p.ProcessId));
  const roots = selected.filter((p) => !ids.has(p.ParentProcessId));
  return [...roots, ...selected.filter((p) => ids.has(p.ParentProcessId))];
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

function psJson(script, env) {
  const out = powershell(`${script} | ConvertTo-Json -Compress`, env);
  if (!out) return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}

function claudeProcesses() {
  return psJson(
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
      "Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='Created';e={ $_.CreationDate.ToFileTimeUtc() }}"
  );
}

function detectTarget() {
  const packages = psJson(
    "Get-AppxPackage -Name Claude | ForEach-Object { $m = Get-AppxPackageManifest $_; [pscustomobject]@{ " +
      "Name = $_.Name; PublisherId = $_.PublisherId; PackageFamilyName = $_.PackageFamilyName; " +
      "InstallLocation = $_.InstallLocation; AppIds = @($m.Package.Applications.Application | ForEach-Object { $_.Id }) } }"
  );
  return pickLaunchTarget(packages);
}

// Stop each process only if it is still the one that was selected: open it by
// PID (the open handle keeps the PID from being reused while we look), then
// compare start time and executable path before killing. Returns one line per
// process: killed / would-kill / gone / skip / error.
function stopProcesses(procs, dryRun) {
  if (procs.length === 0) return [];
  const script = `
    $targets = $env:CB_STOP | ConvertFrom-Json
    foreach ($t in @($targets)) {
      try { $p = [System.Diagnostics.Process]::GetProcessById([int]$t.ProcessId) } catch { "gone $($t.ProcessId)"; continue }
      try {
        $null = $p.Handle
        $same = ([math]::Abs($p.StartTime.ToFileTimeUtc() - [long]$t.Created) -le 10000000) -and ($p.Path -eq $t.ExecutablePath)
        if (-not $same) { "skip $($t.ProcessId) (no longer the selected process)"; continue }
        if ($env:CB_STOP_DRY -eq '1') { "would-kill $($t.ProcessId)"; continue }
        $p.Kill(); "killed $($t.ProcessId)"
      } catch { "error $($t.ProcessId) $($_.Exception.Message)" }
    }`;
  const env = { ...process.env, CB_STOP: JSON.stringify(procs), CB_STOP_DRY: dryRun ? "1" : "0" };
  return powershell(script, env).split(/\r?\n/).filter(Boolean);
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
  return { updated: before !== after, before, after };
}

function ensureDeps(dryRun) {
  const read = (f) => fs.readFileSync(path.join(SERVER, f));
  const currentHash = depsHash(read("package.json"), read("package-lock.json"));
  let installedHash = null;
  try {
    installedHash = JSON.parse(fs.readFileSync(DEPS_MARKER, "utf8")).hash;
  } catch {
    /* no marker: never installed by this script, or install did not finish */
  }
  const nodeModulesExists = fs.existsSync(path.join(SERVER, "node_modules"));
  if (!needsDepsInstall({ nodeModulesExists, currentHash, installedHash })) return;
  if (dryRun) {
    console.log("would run: npm ci --prefix server");
    return;
  }
  console.log("installing server dependencies: npm ci --prefix server");
  // npm is a .cmd shim on Windows, which Node only spawns through a shell.
  // Fixed arguments, no user input.
  if (run("npm", ["ci", "--prefix", "server"], { shell: process.platform === "win32" }).status !== 0) {
    throw new Error("npm ci failed; not restarting. Re-run to retry the install.");
  }
  fs.writeFileSync(DEPS_MARKER, JSON.stringify({ hash: currentHash, installedAt: new Date().toISOString() }));
}

// Spawn the restart helper outside Claude's process tree (WMI parents it to
// the WMI provider host, not to us), with its window hidden. The command line
// is built from process.execPath and this file's path, both absolute paths
// that cannot contain a double quote on Windows.
function launchHelper(logFile, dryRun) {
  const args = [process.execPath, SELF, "--restart-helper", "--log", logFile, ...(dryRun ? ["--dry-run"] : [])];
  const commandLine = args.map((a) => `"${a}"`).join(" ");
  powershell(
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 };" +
      "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ " +
      "CommandLine = $env:CB_HELPER_CMD; CurrentDirectory = $env:CB_HELPER_CWD; ProcessStartupInformation = $si };" +
      "if ($r.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($r.ReturnValue)\" }",
    { ...process.env, CB_HELPER_CMD: commandLine, CB_HELPER_CWD: ROOT }
  );
}

// Runs detached: stop Claude Desktop, wait for it to be gone, relaunch it.
function restartHelper(logFile, dryRun) {
  const log = (m) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  let target = null;
  let stopBegan = false;
  let relaunched = false;
  const relaunch = () => {
    run(target.launch[0], target.launch.slice(1), { capture: true }); // explorer's exit code is meaningless
    relaunched = true;
  };
  try {
    log(`helper start pid=${process.pid}${dryRun ? " (dry run)" : ""}`);
    sleep(1500); // let the invoking script print and exit
    target = detectTarget();
    if (!target) throw new Error(`Anthropic's Claude package (publisher ${ANTHROPIC_PUBLISHER_ID}) is not installed`);
    const current = () => selectAppProcesses(claudeProcesses(), { target, env: process.env });
    let procs = current();
    log(`package=${target.family} at ${target.installLocation}; ${procs.length} process(es); relaunch: ${target.launch.join(" ")}`);
    if (dryRun) {
      for (const line of stopProcesses(stopOrder(procs), true)) log(line);
      log("dry run: nothing stopped or launched");
      return;
    }
    stopBegan = true;
    for (let round = 0; round < 30 && procs.length; round++) {
      // Main process first; children usually exit with it. Re-select every
      // round so each kill uses a fresh identity.
      if (round % 4 === 0) for (const line of stopProcesses(stopOrder(procs), false)) log(line);
      sleep(500);
      procs = current();
    }
    if (procs.length) throw new Error(`still running after 15s: ${procs.map((p) => `${p.ProcessId} ${p.ExecutablePath}`).join("; ")}`);
    log("all Claude Desktop processes stopped");
    relaunch();
    for (let i = 0; i < 40; i++) {
      sleep(500);
      if (current().length) {
        log("Claude Desktop relaunched");
        return;
      }
    }
    throw new Error("relaunch requested but no Claude process appeared within 20s");
  } catch (e) {
    log(`ERROR ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (stopBegan && !relaunched && target) {
      try {
        relaunch();
        log("recovery: relaunch requested after the error above");
      } catch (e) {
        log(`recovery relaunch failed: ${e.message}`);
      }
    }
    if (process.exitCode) {
      log(
        "If Claude does not start: open it from the Start menu. If that fails too, some Desktop builds " +
          "reportedly need `Restart-Service CoworkVMService` from an administrator PowerShell after a quit."
      );
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logFile = opts.log || path.join(os.tmpdir(), "codex-broker-restart.log");
  if (opts.helper) return restartHelper(logFile, opts.dryRun);

  if (opts.pull) {
    if (opts.dryRun) console.log("would run: git pull --ff-only");
    else {
      const r = pull();
      console.log(r.updated ? `pulled ${r.before.slice(0, 7)}..${r.after.slice(0, 7)}` : "already up to date");
    }
  }
  if (opts.pull || opts.tests) ensureDeps(opts.dryRun);

  if (opts.tests) {
    if (opts.dryRun) console.log("would run: node server/test/run-tests.mjs");
    else if (run(process.execPath, ["test/run-tests.mjs"], { cwd: SERVER }).status !== 0) {
      throw new Error("tests failed; not restarting. The running broker is unchanged until the next app restart.");
    }
  }

  if (!opts.restart) return;
  if (process.platform !== "win32") {
    console.log("restart: quit Claude Desktop completely and reopen it (automatic restart is Windows-only)");
    return;
  }
  const target = detectTarget();
  if (!target) throw new Error("Claude Desktop (Anthropic's MSIX package) not found; restart it by hand");
  const procs = selectAppProcesses(claudeProcesses(), { target, env: process.env });
  console.log(`Claude Desktop ${target.family}: ${procs.length} process(es) to stop, relaunch via ${target.launch.join(" ")}`);
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
