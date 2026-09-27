#!/usr/bin/env node
// Integration tests: spawn server.mjs and talk to it over real stdio JSON-RPC
// (MCP newline-delimited framing). A mock `codex` is placed first on PATH so no
// network/OpenAI access is needed. Prints PASS/FAIL per case; exit 1 if any fail.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildGitConfigEnv,
  computeCodexBinary,
  locateWindowsCodexExe,
  windowsModuleDirs,
} from "../lib/util.mjs";
import { buildResumeArgs, buildReviewArgs, buildTaskArgs } from "../lib/codex.mjs";
import { applyChanges, report as configReport } from "../../scripts/configure-codex.mjs";
import {
  claudeModelVerdict,
  codexModelVerdict,
  exitCode as doctorExit,
  MIN_CODEX,
  parseVersion,
  sandboxVerdict,
  versionAtLeast,
} from "../../scripts/doctor.mjs";
import {
  ANTHROPIC_PUBLISHER_ID,
  depsHash,
  needsDepsInstall,
  parseArgs as updaterArgs,
  pickLaunchTarget,
  selectAppProcesses,
  stopOrder,
} from "../../scripts/update-broker.mjs";
import { correlate, errorBuckets, findJob, report as forensicsReport } from "../lib/forensics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.mjs");
const MOCK = path.join(HERE, "mock-codex.mjs");
const TEST_EXIT_GRACE_MS = 50;
process.env.CODEX_BROKER_EXIT_GRACE_MS = String(TEST_EXIT_GRACE_MS);
// Stall detection knobs, shrunk so the tests run in seconds (defaults: 600s / 30s).
process.env.CODEX_BROKER_STALL_WARN_SECONDS = "2";
process.env.CODEX_BROKER_STALL_SWEEP_MS = "500";

// --- Test environment setup ------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-test-"));
const binDir = path.join(tmpRoot, "bin");
const brokerHome = path.join(tmpRoot, "broker-home");
const workDir = path.join(tmpRoot, "work"); // codex cwd (need not be a git repo)
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(brokerHome, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });
process.env.CODEX_BROKER_HOME = brokerHome;

let codexLink;
let mockGh;
let mockNodeOptions = process.env.NODE_OPTIONS || "";
if (process.platform === "win32") {
  // A copied node.exe is a genuinely spawnable PE executable. The preload
  // dispatches by executable name, before Node tries to treat argv[0] as a JS
  // entry point. It is inherited by the broker too, where it is a no-op.
  codexLink = path.join(binDir, "codex.exe");
  mockGh = path.join(binDir, "gh.exe");
  fs.copyFileSync(process.execPath, codexLink);
  fs.copyFileSync(process.execPath, mockGh);
  const preload = pathToFileURL(path.join(HERE, "windows-mock-preload.mjs")).href;
  mockNodeOptions = `${mockNodeOptions} --import=${preload}`.trim();
} else {
  // The mock is ESM, and Node 18 cannot load an extensionless file as ESM under
  // any arrangement: with no "type":"module" context it is parsed as CommonJS
  // and dies on its own `import`, and with one it fails outright with
  // ERR_UNKNOWN_FILE_EXTENSION. So the PATH entry cannot itself be the mock.
  // Copy the mock under its real .mjs name and put a tiny sh shim on PATH,
  // which also gives the mock the same argv shape a shebang would.
  const mockCodex = path.join(binDir, "mock-codex.mjs");
  fs.copyFileSync(MOCK, mockCodex);

  codexLink = path.join(binDir, "codex");
  fs.writeFileSync(codexLink, `#!/bin/sh\nexec "${process.execPath}" "${mockCodex}" "$@"\n`);
  fs.chmodSync(codexLink, 0o755);

  // Mock gh for the v1.5.0 gh_* pass-through tests: echoes its argv.
  mockGh = path.join(binDir, "gh");
  fs.writeFileSync(mockGh, '#!/bin/sh\necho "MOCKGH $@"\n');
  fs.chmodSync(mockGh, 0o755);
}

const childEnv = {
  ...process.env,
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  CODEX_BROKER_HOME: brokerHome,
  GH_BIN: mockGh,
  // Ensure no ambient overrides leak in.
  CODEX_BIN: process.platform === "win32" ? codexLink : "",
  CODEX_MODEL: "",
  CODEX_BROKER_EXIT_GRACE_MS: String(TEST_EXIT_GRACE_MS),
  ...(process.platform === "win32" ? { NODE_OPTIONS: mockNodeOptions } : {}),
};

// --- Minimal MCP stdio JSON-RPC client -------------------------------------
class Client {
  constructor(env = childEnv) {
    this.proc = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", () => {}); // swallow server logs
  }
  _onData(d) {
    this.buf += d.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }
  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    this._send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }
  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }
  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-harness", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return res;
  }
  async call(name, args, timeoutMs = 30000) {
    const res = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = (res.content || []).map((c) => c.text || "").join("\n");
    return { isError: !!res.isError, text, raw: res };
  }
  close() {
    try {
      this.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Test runner -----------------------------------------------------------
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function extractJobId(text) {
  const m = text.match(/job_id:\s*(\S+)/);
  return m ? m[1] : null;
}
function extractSessionId(text) {
  const m = text.match(/Session id:\s*(\S+)/);
  return m && m[1] !== "(not" ? m[1] : null;
}

const client = new Client();

// --- Windows binary-resolution unit tests (simulated tree on any OS) -------
async function runWindowsResolutionTests() {
  // Build a fake Windows npm-global layout under a temp dir. path.join uses the
  // host separator, but the same separator is used to construct and to search,
  // so the logic is exercised faithfully without needing real Windows.
  const winTmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-"));
  const appdata = path.join(winTmp, "AppData", "Roaming");
  const exeDir = path.join(
    appdata,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin"
  );
  fs.mkdirSync(exeDir, { recursive: true });
  const exePath = path.join(exeDir, "codex.exe");
  fs.writeFileSync(exePath, "");

  // A PATH dir holding a codex.cmd shim, with its own vendored exe sibling.
  const shimDir = path.join(winTmp, "shimbin");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "codex.cmd"), "@echo off");
  const shimExeDir = path.join(
    shimDir,
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-arm64",
    "vendor",
    "aarch64-pc-windows-msvc",
    "bin"
  );
  fs.mkdirSync(shimExeDir, { recursive: true });
  fs.writeFileSync(path.join(shimExeDir, "codex.exe"), "");

  await test("win32: windowsModuleDirs finds APPDATA npm + codex.cmd sibling", async () => {
    const env = { APPDATA: appdata, PATH: `${shimDir}${path.delimiter}/usr/bin` };
    const dirs = windowsModuleDirs(env);
    assert(dirs.some((d) => d.includes(path.join("npm", "node_modules"))), `missing appdata dir: ${dirs}`);
    assert(dirs.some((d) => d === path.join(shimDir, "node_modules")), `missing shim sibling: ${dirs}`);
  });

  await test("win32: locateWindowsCodexExe finds vendored codex.exe", async () => {
    const env = { APPDATA: appdata, PATH: "" };
    const found = locateWindowsCodexExe(windowsModuleDirs(env));
    assert(found === exePath, `expected ${exePath}, got ${found}`);
  });

  await test("win32: computeCodexBinary resolves the vendored exe, never a .cmd", async () => {
    const found = computeCodexBinary({ APPDATA: appdata, PATH: "" }, "win32");
    assert(found === exePath, `expected vendored exe, got ${found}`);
    assert(!/\.cmd$/i.test(found), `must not resolve to a .cmd shim: ${found}`);
  });

  await test("win32: falls back to codex.exe when nothing is found", async () => {
    const found = computeCodexBinary({ APPDATA: path.join(winTmp, "nope"), PATH: "" }, "win32");
    assert(found === "codex.exe", `expected codex.exe fallback, got ${found}`);
  });

  await test("CODEX_BIN override wins and is validated (existing file)", async () => {
    const found = computeCodexBinary({ CODEX_BIN: exePath }, "win32");
    assert(found === exePath, `expected override ${exePath}, got ${found}`);
  });

  await test("CODEX_BIN pointing at a missing file throws a clear error", async () => {
    let threw = null;
    try {
      computeCodexBinary({ CODEX_BIN: path.join(winTmp, "does-not-exist.exe") }, "win32");
    } catch (e) {
      threw = e.message;
    }
    assert(threw && /CODEX_BIN/.test(threw) && /does not exist|no file exists/.test(threw), `bad error: ${threw}`);
  });

  await test("non-win32: computeCodexBinary returns bare 'codex'", async () => {
    const found = computeCodexBinary({ PATH: "" }, "linux");
    assert(found === "codex", `expected 'codex', got ${found}`);
  });

  fs.rmSync(winTmp, { recursive: true, force: true });
}

async function main() {
  await test("manifest, package, and server versions stay in lockstep", async () => {
    const repoRoot = path.resolve(HERE, "..", "..");
    const manifestVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8")).version;
    const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "server", "package.json"), "utf8")).version;
    const serverSource = fs.readFileSync(path.join(repoRoot, "server", "server.mjs"), "utf8");
    const serverVersion = serverSource.match(/name:\s*["']codex-broker["']\s*,\s*version:\s*["']([^"']+)["']/)?.[1];
    // The plugin pins its version, so plugin users only get an update when it changes.
    const pluginVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
    const rootPackageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    const all = { "manifest.json": manifestVersion, "server/package.json": packageVersion, "server/server.mjs": serverVersion, ".claude-plugin/plugin.json": pluginVersion, "package.json": rootPackageVersion };
    assert(new Set(Object.values(all)).size === 1, `version mismatch: ${JSON.stringify(all)}`);
  });

  await test("plugin manifest points at real files, and its dependencies match the server's exactly", async () => {
    const repoRoot = path.resolve(HERE, "..", "..");
    const read = (p) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), "utf8"));
    const plugin = read(".claude-plugin/plugin.json");
    const market = read(".claude-plugin/marketplace.json");
    const entry = market.plugins.find((p) => p.name === plugin.name);
    assert(entry && entry.source === "./", `marketplace must list ${plugin.name} at the repo root: ${JSON.stringify(market.plugins)}`);
    const srv = plugin.mcpServers["codex-broker"];
    assert(srv && srv.command === "node" && srv.args[0] === "${CLAUDE_PLUGIN_ROOT}/server/server.mjs", `mcp server: ${JSON.stringify(srv)}`);
    for (const dir of plugin.skills) {
      assert(fs.existsSync(path.join(repoRoot, dir, "SKILL.md")), `skills path ${dir} has no SKILL.md`);
    }
    assert(fs.existsSync(path.join(repoRoot, "skills", "setup", "SKILL.md")), "setup skill missing");
    // Claude Code runs `npm ci --ignore-scripts` at the plugin root; server/ resolves
    // the result. The root lockfile must pin exactly what the server is tested with.
    const rootPkg = read("package.json");
    const serverPkg = read("server/package.json");
    assert(JSON.stringify(rootPkg.dependencies) === JSON.stringify(serverPkg.dependencies), "root package.json dependencies differ from server/package.json");
    const pkgs = (lock) => Object.fromEntries(Object.entries(lock.packages).filter(([k]) => k !== ""));
    const rootLock = pkgs(read("package-lock.json"));
    const serverLock = pkgs(read("server/package-lock.json"));
    assert(JSON.stringify(rootLock) === JSON.stringify(serverLock), "package-lock.json differs from server/package-lock.json; regenerate it from the server lockfile");
  });

  await test("doctor parses versions and reads the Windows sandbox verdict from codex doctor --json", async () => {
    assert(JSON.stringify(parseVersion("codex-cli 0.157.1")) === "[0,157,1]", "parse codex version");
    assert(parseVersion("garbage") === null, "unparseable version");
    assert(versionAtLeast([0, 153, 1], MIN_CODEX) && versionAtLeast([1, 0, 0], MIN_CODEX), "at or above the floor");
    assert(!versionAtLeast([0, 153, 0], MIN_CODEX) && !versionAtLeast(null, MIN_CODEX), "below the floor or unknown");
    const doc = (backend, provisioning) => ({ checks: { "sandbox.helpers": { details: { "sandbox backend": backend, "sandbox provisioning": provisioning } } } });
    assert(sandboxVerdict(doc("elevated", "complete"), "win32").status === "ok", "provisioned elevated sandbox is ok");
    const un = sandboxVerdict(doc("unelevated", "complete"), "win32");
    assert(un.status === "fail" && /sandbox setup --elevated --current-user/.test(un.fix), `unelevated must fail with the setup command: ${JSON.stringify(un)}`);
    assert(sandboxVerdict(doc(undefined, undefined), "win32").status === "fail", "unset backend must fail");
    assert(sandboxVerdict(null, "win32").status === "fail", "unreadable doctor output must fail closed, never report Ready");
    assert(sandboxVerdict({ checks: {} }, "win32").status === "fail", "a doctor report without the sandbox check must fail closed");
    assert(sandboxVerdict(null, "linux").status === "ok", "non-Windows skips the check");
    assert(doctorExit([{ status: "ok" }, { status: "warn" }]) === 0 && doctorExit([{ status: "ok" }, { status: "fail" }]) === 1, "exit code");
  });

  await test("doctor keeps the orchestrator on the newest Opus at High effort", async () => {
    const good = { model: "opus", modelSettings: { "claude-opus-5-5": { effortLevel: "high" }, "claude-fable-5-1": { effortLevel: "high" } } };
    assert(claudeModelVerdict(good, {}).status === "ok", `alias + high efforts should pass: ${JSON.stringify(claudeModelVerdict(good, {}))}`);
    const cases = [
      [{}, /no default model/],
      [{ ...good, model: "claude-opus-5-5" }, /pinned/],
      [{ ...good, model: "sonnet" }, /should be Opus/],
      [{ model: "opus" }, /no saved effort/],
      [{ ...good, modelSettings: { "claude-opus-5-5": { effortLevel: "medium" } } }, /claude-opus-5-5 effort is medium/],
      [{ ...good, modelSettings: { "claude-opus-5-5": {} } }, /claude-opus-5-5 effort is unset/],
    ];
    for (const [settings, re] of cases) {
      const v = claudeModelVerdict(settings, {});
      assert(v.status === "warn" && re.test(v.summary), `${JSON.stringify(settings)} -> ${JSON.stringify(v)}`);
    }
    const env = claudeModelVerdict(good, { CLAUDE_CODE_EFFORT_LEVEL: "low" });
    assert(env.status === "warn" && /overrides every saved effort/.test(env.summary), `env override must be reported: ${JSON.stringify(env)}`);
  });

  await test("doctor compares Codex's configured model with the top of Codex's own catalog", async () => {
    const lv = (...e) => e.map((effort) => ({ effort }));
    const catalog = {
      models: [
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", priority: 2, visibility: "list", supported_in_api: true, supported_reasoning_levels: lv("low", "max", "ultra") },
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", priority: 1, visibility: "list", supported_in_api: true, supported_reasoning_levels: lv("low", "max", "ultra") },
        { slug: "gpt-hidden", priority: 0, visibility: "hide", supported_in_api: true, supported_reasoning_levels: lv("low") },
        { slug: "gpt-5.5", priority: 12, visibility: "list", supported_in_api: true, supported_reasoning_levels: lv("low", "xhigh"), upgrade: { retirement_at: "2026-10-14T19:00:00Z" } },
      ],
    };
    assert(codexModelVerdict({ model: "gpt-6-astra", effort: "ultra" }, catalog).status === "ok", "top model at a supported effort should pass (hidden models don't count)");
    const older = codexModelVerdict({ model: "gpt-6-sol", effort: "ultra" }, catalog);
    assert(older.status === "warn" && /newer model available: gpt-6-astra/.test(older.summary), `older model: ${JSON.stringify(older)}`);
    const retiring = codexModelVerdict({ model: "gpt-5.5", effort: "ultra" }, catalog);
    assert(/retires 2026-10-14/.test(retiring.summary) && /effort "ultra" isn't supported/.test(retiring.summary), `retiring + effort: ${JSON.stringify(retiring)}`);
    assert(/not in Codex's catalog/.test(codexModelVerdict({ model: "gpt-typo" }, catalog).summary), "unknown model");
    assert(/no model in config.toml/.test(codexModelVerdict({ model: null }, catalog).summary), "unset model");
    assert(codexModelVerdict({ model: "gpt-6-astra" }, null).status === "warn", "missing catalog warns");
  });

  await runWindowsResolutionTests();

  await test("readJob gives a dead pid an exit-file grace window", async () => {
    const { readJob } = await import("../lib/jobs.mjs");
    const exited = spawn(process.execPath, ["-e", ""]);
    const deadPid = exited.pid;
    await new Promise((resolve, reject) => {
      exited.once("error", reject);
      exited.once("exit", resolve);
    });

    const jobId = "dead-pid-grace-window";
    const jobDir = path.join(brokerHome, "jobs", jobId);
    const outputLog = path.join(jobDir, "output.log");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(outputLog, "");
    fs.writeFileSync(
      path.join(jobDir, "meta.json"),
      JSON.stringify({
        job_id: jobId,
        pid: deadPid,
        startedAt: Date.now(),
        outputLog,
        lastMessageFile: path.join(jobDir, "last-message.txt"),
        canceled: false,
        timedOut: false,
      })
    );

    const settling = readJob(jobId);
    assert(settling.status === "running", `expected grace-window running status, got: ${settling.status}`);
    await sleep(TEST_EXIT_GRACE_MS + 20);
    const failed = readJob(jobId);
    assert(failed.status === "failed", `expected failed after grace window, got: ${failed.status}`);
    assert(
      failed.reason === "process exited without recording status",
      `unexpected failure reason: ${failed.reason}`
    );
  });

  await client.initialize();
  const tools = await client.request("tools/list", {});
  await test("tools/list exposes all 15 tools", async () => {
    const names = tools.tools.map((t) => t.name).sort();
    const expected = [
      "codex_cancel",
      "codex_resume",
      "codex_result",
      "codex_review",
      "codex_start",
      "codex_status",
      "codex_task",
      "git_push",
      "git_pull",
      "git_commit",
      "git_clone",
      "gh_repo_create",
      "gh_read",
      "gh_pr_create",
      "gh_issue_create",
    ].sort();
    assert(JSON.stringify(names) === JSON.stringify(expected), `got tools: ${names.join(",")}`);
  });

  await test("sync task success", async () => {
    const r = await client.call("codex_task", { prompt: "hello world", cwd: workDir });
    assert(!r.isError, `unexpected error: ${r.text}`);
    assert(/Status: completed \(exit 0\)/.test(r.text), `no completed status: ${r.text}`);
    assert(/Task complete \(mock\)/.test(r.text), `no final message: ${r.text}`);
    assert(extractSessionId(r.text), `no session id surfaced: ${r.text}`);
  });

  await test("sync timeout kills process and returns partial + error", async () => {
    const start = Date.now();
    const r = await client.call("codex_task", {
      prompt: "SLEEP=30 long task",
      cwd: workDir,
      timeout_seconds: 2,
    });
    const elapsed = Date.now() - start;
    assert(r.isError, `expected error result, got: ${r.text}`);
    assert(/TIMEOUT/.test(r.text), `no TIMEOUT notice: ${r.text}`);
    assert(elapsed < 15000, `took too long (${elapsed}ms) — kill likely failed`);
  });

  await test("start -> status(running) -> result-error -> completion -> result", async () => {
    const s = await client.call("codex_start", { prompt: "SLEEP=3 background build", cwd: workDir });
    assert(!s.isError, `start failed: ${s.text}`);
    const jobId = extractJobId(s.text);
    assert(jobId, `no job_id: ${s.text}`);

    const st = await client.call("codex_status", { job_id: jobId });
    assert(/status: running/.test(st.text), `expected running, got: ${st.text}`);

    const early = await client.call("codex_result", { job_id: jobId });
    assert(early.isError && /still running/.test(early.text), `expected running error: ${early.text}`);

    // Poll to completion.
    let done = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const p = await client.call("codex_status", { job_id: jobId });
      if (/status: completed/.test(p.text)) {
        done = true;
        break;
      }
      if (/status: failed/.test(p.text)) throw new Error(`job failed: ${p.text}`);
    }
    assert(done, "job did not complete within 20s");

    const fin = await client.call("codex_result", { job_id: jobId });
    assert(!fin.isError, `result errored: ${fin.text}`);
    assert(/Task complete \(mock\)/.test(fin.text), `no final message: ${fin.text}`);
    assert(/status: completed/.test(fin.text), `not completed: ${fin.text}`);
  });

  await test("cancel kills a running job", async () => {
    const s = await client.call("codex_start", { prompt: "SLEEP=30 never finishes", cwd: workDir });
    const jobId = extractJobId(s.text);
    assert(jobId, `no job_id: ${s.text}`);
    await sleep(400); // let it start
    const c = await client.call("codex_cancel", { job_id: jobId });
    assert(!c.isError && /Canceled/.test(c.text), `cancel failed: ${c.text}`);
    await sleep(400);
    const st = await client.call("codex_status", { job_id: jobId });
    assert(/status: failed \(canceled\)/.test(st.text), `expected canceled, got: ${st.text}`);
  });

  await test("ALL jobs spawn codex directly: no runner artifacts anywhere", async () => {
    const r = await client.call("codex_task", { prompt: "direct spawn check", cwd: workDir });
    assert(!r.isError && /Status: completed/.test(r.text), `sync task failed: ${r.text}`);
    // Inspect every job dir (direct AND background) and confirm no runner ever ran.
    const jobsRoot = path.join(brokerHome, "jobs");
    const dirs = fs.readdirSync(jobsRoot);
    let count = 0;
    for (const d of dirs) {
      const metaPath = path.join(jobsRoot, d, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      count++;
      assert(!fs.existsSync(path.join(jobsRoot, d, "command.json")), `job ${d} wrote command.json (runner-era artifact)`);
      assert(!fs.existsSync(path.join(jobsRoot, d, "runner-boot.log")), `job ${d} spawned a runner`);
    }
    assert(count > 0, "no job dirs found");
  });

  await test("background job spawns codex DIRECTLY and records completion from the broker", async () => {
    const s = await client.call("codex_start", { prompt: "SLEEP=1 direct background", cwd: workDir });
    const jobId = extractJobId(s.text);
    assert(jobId, `no job_id: ${s.text}`);
    const jobDir = path.join(brokerHome, "jobs", jobId);

    // The broker's direct-spawn breadcrumb (mode=background) goes to output.log.
    const out = fs.readFileSync(path.join(jobDir, "output.log"), "utf8");
    assert(/\[broker\] direct spawn of .+ \(mode=background\)/.test(out), `missing direct-spawn breadcrumb: ${JSON.stringify(out)}`);

    // meta.pid is the codex process itself (not a runner), and it is alive now.
    const meta = JSON.parse(fs.readFileSync(path.join(jobDir, "meta.json"), "utf8"));
    assert(meta.mode === "background", `expected mode background, got ${meta.mode}`);
    assert(Number.isInteger(meta.pid) && meta.pid > 0, `bad codex pid in meta: ${meta.pid}`);
    assert(meta.runnerExecPath === undefined, "meta still records runnerExecPath (runner-era field)");

    // The broker-side exit handler must write the exit file when codex finishes.
    let exitVal = null;
    for (let i = 0; i < 30; i++) {
      const p = path.join(jobDir, "exit");
      if (fs.existsSync(p)) {
        exitVal = fs.readFileSync(p, "utf8").trim();
        break;
      }
      await sleep(200);
    }
    assert(exitVal === "0", `expected exit file "0", got ${JSON.stringify(exitVal)}`);

    const fin = await client.call("codex_result", { job_id: jobId });
    assert(!fin.isError && /status: completed/.test(fin.text), `background result not completed: ${fin.text}`);
    assert(/Task complete \(mock\)/.test(fin.text), `no final message: ${fin.text}`);
  });

  await test("review (sync) returns findings", async () => {
    const r = await client.call("codex_review", { cwd: workDir, focus: "security and error handling" });
    assert(!r.isError, `review errored: ${r.text}`);
    assert(/Code review complete \(mock\)/.test(r.text), `no review output: ${r.text}`);
    assert(/security and error handling/.test(r.text), `focus not passed through: ${r.text}`);
  });

  await test("review (background) returns a job_id", async () => {
    const r = await client.call("codex_review", { cwd: workDir, background: true });
    assert(!r.isError && extractJobId(r.text), `no job_id: ${r.text}`);
  });

  await test("resume continues a session", async () => {
    const t = await client.call("codex_task", { prompt: "first turn", cwd: workDir });
    const sid = extractSessionId(t.text);
    assert(sid, `no session id from task: ${t.text}`);
    const r = await client.call("codex_resume", { thread_id: sid, prompt: "second turn", cwd: workDir });
    assert(!r.isError, `resume errored: ${r.text}`);
    assert(new RegExp(`Resumed session ${sid}`).test(r.text), `resume did not use session id: ${r.text}`);
  });

  await test("invalid sandbox is rejected before spawning", async () => {
    const r = await client.call("codex_task", {
      prompt: "x",
      cwd: workDir,
      sandbox: "danger-full-access",
    });
    assert(r.isError && /Invalid sandbox/.test(r.text), `expected rejection, got: ${r.text}`);
  });

  await test("invalid cwd is rejected", async () => {
    const r = await client.call("codex_task", { prompt: "x", cwd: "/no/such/directory/here" });
    assert(r.isError && /does not exist/.test(r.text), `expected rejection, got: ${r.text}`);
  });

  await test("non-absolute cwd is rejected", async () => {
    const r = await client.call("codex_task", { prompt: "x", cwd: "relative/path" });
    assert(r.isError && /absolute/.test(r.text), `expected rejection, got: ${r.text}`);
  });

  await test("git_push validates branch names (rejects flag injection)", async () => {
    const r = await client.call("git_push", { cwd: workDir, branch: "--force" });
    assert(r.isError && /Invalid branch/.test(r.text), `expected rejection, got: ${r.text}`);
  });

  await test("gh_repo_create validates repo name", async () => {
    const r = await client.call("gh_repo_create", { cwd: workDir, name: "bad name; rm -rf" });
    assert(r.isError && /Invalid repo name/.test(r.text), `expected rejection, got: ${r.text}`);
  });

  await test("git_push runs broker-side and reports failure cleanly on non-repo", async () => {
    const r = await client.call("git_push", { cwd: workDir, branch: "main" });
    // workDir is not a git repo; git exits nonzero — we only assert clean structured failure, no crash
    assert(/git push origin main: (OK|FAILED)/.test(r.text), `unexpected output: ${r.text}`);
  });

  await test("network:true adds sandbox network config flag (workspace-write only)", async () => {
    const a = buildTaskArgs({ sandbox: "workspace-write", model: null, lastMessageFile: "x", network: true });
    assert(a.includes("-c") && a.includes("sandbox_workspace_write.network_access=true"), "flag missing for workspace-write+network");
    const b = buildTaskArgs({ sandbox: "read-only", model: null, lastMessageFile: "x", network: true });
    assert(!b.includes("sandbox_workspace_write.network_access=true"), "flag wrongly added under read-only");
    const c = buildTaskArgs({ sandbox: "workspace-write", model: null, lastMessageFile: "x" });
    assert(!c.includes("sandbox_workspace_write.network_access=true"), "flag wrongly added by default");
  });

  // ---- v1.6.0: keep-awake / HTTPS-only overrides, stall signal, config script

  await test("every codex spawn carries the keep-awake override; CODEX_BROKER_KEEP_AWAKE=0 opts out", async () => {
    const on = { CODEX_BROKER_KEEP_AWAKE: "1" };
    const off = { CODEX_BROKER_KEEP_AWAKE: "0" };
    const has = (a) => a.some((x, i) => x === "-c" && a[i + 1] === "features.prevent_idle_sleep=true");
    assert(has(buildTaskArgs({ sandbox: "workspace-write", model: null, lastMessageFile: "x", env: on })), "task lacks keep-awake");
    assert(has(buildReviewArgs({ model: null, hasFocus: false, lastMessageFile: "x", env: on })), "review lacks keep-awake");
    assert(has(buildResumeArgs({ sessionId: "s", model: null, lastMessageFile: "x", env: on })), "resume lacks keep-awake");
    assert(!has(buildTaskArgs({ sandbox: "workspace-write", model: null, lastMessageFile: "x", env: off })), "opt-out ignored");
    // Overrides sit before the model flag and the stdin sentinel stays last.
    const a = buildTaskArgs({ sandbox: "read-only", model: "m1", lastMessageFile: "x", env: on });
    assert(a.indexOf("-m") > a.indexOf("features.prevent_idle_sleep=true") && a[a.length - 1] === "-", `bad order: ${a.join(" ")}`);
  });

  await test("CODEX_BROKER_TRANSPORT=https adds an HTTPS-only ChatGPT provider; default does not", async () => {
    const a = buildTaskArgs({ sandbox: "read-only", model: null, lastMessageFile: "x", env: { CODEX_BROKER_TRANSPORT: "https" } });
    const vals = a.filter((_, i) => a[i - 1] === "-c");
    assert(vals.includes('model_provider="codex_broker_https"'), `no provider switch: ${a.join(" ")}`);
    assert(vals.includes("model_providers.codex_broker_https.supports_websockets=false"), "websockets not disabled");
    assert(vals.includes("model_providers.codex_broker_https.requires_openai_auth=true"), "chatgpt auth not kept");
    assert(!a.some((x) => /danger/.test(x)), "danger flag leaked");
    const b = buildTaskArgs({ sandbox: "read-only", model: null, lastMessageFile: "x", env: {} });
    assert(!b.some((x) => /model_provider/.test(x)), "provider override added by default");
  });

  // ---- v1.7.0: per-call reasoning-effort override

  await test("reasoning_effort adds a model_reasoning_effort override on every builder; omitted adds none", async () => {
    const has = (a, v) => a.some((x, i) => x === "-c" && a[i + 1] === `model_reasoning_effort="${v}"`);
    assert(has(buildTaskArgs({ sandbox: "workspace-write", model: null, effort: "max", lastMessageFile: "x", env: {} }), "max"), "task lacks effort");
    assert(has(buildReviewArgs({ model: null, effort: "ultra", hasFocus: false, lastMessageFile: "x", env: {} }), "ultra"), "review lacks effort");
    assert(has(buildResumeArgs({ sessionId: "s", model: null, effort: "xhigh", lastMessageFile: "x", env: {} }), "xhigh"), "resume lacks effort");
    const none = buildTaskArgs({ sandbox: "workspace-write", model: null, lastMessageFile: "x", env: {} });
    assert(!none.some((x) => /model_reasoning_effort/.test(x)), "effort override added by default");
    // Sits with the other -c overrides: before the model flag, stdin sentinel last.
    const a = buildTaskArgs({ sandbox: "read-only", model: "m1", effort: "max", lastMessageFile: "x", env: {} });
    assert(a.indexOf("-m") > a.indexOf('model_reasoning_effort="max"') && a[a.length - 1] === "-", `bad order: ${a.join(" ")}`);
    // Builder-level backstop: anything but a bare word is refused even if validation were bypassed.
    let threw = false;
    try {
      buildTaskArgs({ sandbox: "read-only", model: null, effort: 'max" -c sandbox="danger-full-access', lastMessageFile: "x", env: {} });
    } catch {
      threw = true;
    }
    assert(threw, "builder accepted an unsafe effort value");
  });

  await test("invalid reasoning_effort is rejected before spawning; a valid one reaches codex's argv", async () => {
    const bad = await client.call("codex_task", { prompt: "x", cwd: workDir, reasoning_effort: "turbo" });
    assert(bad.isError && /Invalid reasoning_effort/.test(bad.text), `expected rejection, got: ${bad.text}`);
    const good = await client.call("codex_task", { prompt: "effort check", cwd: workDir, reasoning_effort: "max" });
    assert(!good.isError && /Status: completed/.test(good.text), `valid effort rejected: ${good.text}`);
    // Background jobs return their job_id, so inspect the spawned argv there.
    const { readJsonSafe } = await import("../lib/jobs.mjs");
    const readMeta = (text) => readJsonSafe(path.join(brokerHome, "jobs", extractJobId(text), "meta.json"));
    const meta = readMeta(await (await client.call("codex_start", { prompt: "effort check", cwd: workDir, reasoning_effort: "max" })).text);
    const i = meta.argv.indexOf('model_reasoning_effort="max"');
    assert(i > 0 && meta.argv[i - 1] === "-c", `override missing from spawned argv: ${meta.argv.join(" ")}`);
    const metaPlain = readMeta((await client.call("codex_start", { prompt: "no effort", cwd: workDir })).text);
    assert(!metaPlain.argv.some((x) => /model_reasoning_effort/.test(x)), "override leaked into a call that omitted it");
    const metaBg = readMeta((await client.call("codex_review", { cwd: workDir, background: true, reasoning_effort: "ultra" })).text);
    assert(metaBg.argv.includes('model_reasoning_effort="ultra"'), `background review lacks override: ${metaBg.argv.join(" ")}`);
  });

  await test("meta.json survives concurrent rewrites: readJsonSafe never sees a partial file", async () => {
    // CI caught `Unexpected end of JSON input` reading meta.json while the
    // broker rewrote it. A second process reads through readJsonSafe in a
    // tight loop while this one rewrites the file; any null is a failure.
    const { writeMeta } = await import("../lib/jobs.mjs");
    const jobsUrl = pathToFileURL(path.join(HERE, "..", "lib", "jobs.mjs")).href;
    const dir = fs.mkdtempSync(path.join(tmpRoot, "atomic-meta-"));
    const metaFile = path.join(dir, "meta.json");
    const meta = { argv: Array.from({ length: 400 }, (_, i) => `arg-${i}`), n: 0 };
    writeMeta(metaFile, meta);
    // The reader signals "ready" once loaded and reads until the stop file
    // appears, so its loop provably spans the writer's; it also counts the
    // distinct versions it saw, which proves the reads were concurrent.
    const stopFile = path.join(dir, "stop");
    const reader = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const fs = await import("node:fs");` +
          `const { readJsonSafe } = await import(${JSON.stringify(jobsUrl)});` +
          `let bad=0,reads=0;const seen=new Set();process.stdout.write("ready\\n");` +
          `while(!fs.existsSync(process.argv[2])){const m=readJsonSafe(process.argv[1]);if(m===null)bad++;else{reads++;seen.add(m.n)}}` +
          `process.stdout.write(JSON.stringify({bad,reads,versions:seen.size}))`,
        metaFile,
        stopFile,
      ],
      { env: childEnv, stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    const ready = new Promise((resolve) =>
      reader.stdout.on("data", (d) => {
        out += d;
        if (out.includes("ready\n")) resolve();
      })
    );
    const done = new Promise((resolve) => reader.on("exit", resolve));
    await Promise.race([ready, sleep(15000)]);
    assert(out.includes("ready\n"), "reader never started");
    const until = Date.now() + 1300;
    while (Date.now() < until) {
      meta.n++;
      writeMeta(metaFile, meta);
      await new Promise((r) => setImmediate(r));
    }
    fs.writeFileSync(stopFile, "");
    await done;
    const { bad, reads, versions } = JSON.parse(out.slice(out.indexOf("ready\n") + 6));
    assert(versions > 1, `reader saw ${versions} version(s) of meta.json, so the reads were not concurrent with the writes`);
    assert(bad === 0, `${bad} of ${bad + reads} concurrent reads saw a partial meta.json`);
    const left = fs.readdirSync(dir).filter((f) => f !== "stop");
    assert(left.length === 1, `temp files left behind: ${left.join(", ")}`);
  });

  await test("codex_status reports idle time and warns once output goes quiet", async () => {
    const s = await client.call("codex_start", { prompt: "SLEEP=6 quiet job", cwd: workDir });
    const jobId = extractJobId(s.text);
    assert(jobId, `no job_id: ${s.text}`);
    assert(/Stall guard: off/.test(s.text), `no stall-guard line: ${s.text}`);
    await sleep(300);
    const early = await client.call("codex_status", { job_id: jobId });
    assert(/last output: \d+s ago \(\d{4}-/.test(early.text), `no idle line: ${early.text}`);
    assert(!/WARNING: no output/.test(early.text), `warned too early: ${early.text}`);
    await sleep(3500); // mock emits at start, then nothing until it finishes at 6s
    const later = await client.call("codex_status", { job_id: jobId });
    assert(/status: running/.test(later.text), `expected running: ${later.text}`);
    assert(/WARNING: no output for [3-9]s \(stall threshold 2s\)/.test(later.text), `no stall warning: ${later.text}`);
    // Let it finish so later "no runner artifacts" scans see a clean job.
    for (let i = 0; i < 20 && !/status: completed/.test((await client.call("codex_status", { job_id: jobId })).text); i++) await sleep(500);
  });

  await test("max_idle_seconds kills a silent job from the sweeper, with no polling", async () => {
    const s = await client.call("codex_start", { prompt: "SLEEP=40 silent job", cwd: workDir, max_idle_seconds: 5 });
    assert(!s.isError, `start failed: ${s.text}`);
    const jobId = extractJobId(s.text);
    assert(/Stall guard: killed if no output for 5s/.test(s.text), `no stall-guard line: ${s.text}`);
    await sleep(8000); // > 5s idle + a sweep tick; NO codex_status calls in between
    const r = await client.call("codex_result", { job_id: jobId });
    assert(r.isError && /status: failed \(stalled: no output for \d+s \(max_idle_seconds=5\)\)/.test(r.text), `not stalled: ${r.text}`);
    assert(/exit: stalled/.test(r.text), `exit marker missing: ${r.text}`);
    const log = fs.readFileSync(path.join(brokerHome, "jobs", jobId, "output.log"), "utf8");
    assert(/\[broker\] killed after \d+s without output \(max_idle_seconds=5\)/.test(log), `no kill line in log: ${log}`);
    const meta = JSON.parse(fs.readFileSync(path.join(brokerHome, "jobs", jobId, "meta.json"), "utf8"));
    assert(meta.stalled === true && meta.maxIdleSeconds === 5, `meta not marked: ${JSON.stringify(meta)}`);
  });

  await test("a job that keeps producing output is not stalled; max_idle_seconds is validated", async () => {
    // SLEEP=3 finishes before 5s idle could elapse — must complete normally.
    const s = await client.call("codex_start", { prompt: "SLEEP=3 short job", cwd: workDir, max_idle_seconds: 5 });
    const jobId = extractJobId(s.text);
    let fin = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const p = await client.call("codex_status", { job_id: jobId });
      if (/status: (completed|failed)/.test(p.text)) {
        fin = p.text;
        break;
      }
    }
    assert(fin && /status: completed/.test(fin), `expected completed: ${fin}`);
    const bad = await client.call("codex_start", { prompt: "x", cwd: workDir, max_idle_seconds: 1 });
    assert(bad.isError && /max_idle_seconds/.test(bad.text), `bad value accepted: ${bad.text}`);
    const rv = await client.call("codex_review", { cwd: workDir, background: true, max_idle_seconds: 1 });
    assert(rv.isError && /max_idle_seconds/.test(rv.text), `review accepted bad value: ${rv.text}`);
  });

  await test("update-broker trusts only Anthropic's Claude package and stops only its processes", async () => {
    const W = (p) => p.replace(/\//g, "\\"); // write paths with "/", test them as Windows paths
    const pub = ANTHROPIC_PUBLISHER_ID;
    const env = { APPDATA: W("C:/Users/u/AppData/Roaming") };
    const real = {
      Name: "Claude",
      PublisherId: pub,
      PackageFamilyName: `Claude_${pub}`,
      InstallLocation: W(`D:/WindowsApps/Claude_2.9939.2.0_x64__${pub}`),
      AppIds: ["Claude", "SshAskpass"],
    };
    const lookalike = { ...real, PublisherId: "aaaaaaaaaaaaa", PackageFamilyName: "Claude_aaaaaaaaaaaaa", InstallLocation: W("C:/Program Files/WindowsApps/Claude_9.9.9.9_x64__aaaaaaaaaaaaa") };
    // A lookalike listed first must not win, and alone must not qualify.
    const target = pickLaunchTarget([lookalike, real]);
    assert(target && target.family === `Claude_${pub}`, `wrong package trusted: ${JSON.stringify(target)}`);
    assert(target.launch.join(" ") === `explorer.exe shell:AppsFolder${W("/")}Claude_${pub}!Claude`, `launch: ${target.launch}`);
    assert(pickLaunchTarget([lookalike]) === null, "a package from another publisher was trusted");
    assert(pickLaunchTarget([{ ...real, AppIds: ["Other"] }]) === null, "package without the Claude app id was trusted");
    assert(pickLaunchTarget([]) === null, "no package should yield null");

    const pkg = (v) => `D:/WindowsApps/Claude_${v}_x64__${pub}`;
    const procs = [
      { ProcessId: 10, ParentProcessId: 1, ExecutablePath: W(`${pkg("2.9939.2.0")}/app/Claude.exe`) },
      { ProcessId: 11, ParentProcessId: 10, ExecutablePath: W(`${pkg("2.9939.2.0")}/app/Claude.exe`) },
      // The package moved to D: and the app updated past the running version: still Claude's.
      { ProcessId: 13, ParentProcessId: 10, ExecutablePath: W(`${pkg("2.9900.0.0")}/app/Claude.exe`) },
      { ProcessId: 12, ParentProcessId: 10, ExecutablePath: W("C:/Users/u/AppData/Roaming/Claude/claude-code/2.1.281/claude.exe") },
      // Must survive: children of a Claude session, a standalone CLI, another publisher,
      // prefix-only lookalikes, no path.
      { ProcessId: 20, ParentProcessId: 12, ExecutablePath: W("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe") },
      { ProcessId: 21, ParentProcessId: 12, ExecutablePath: W("C:/Users/u/.local/bin/claude.exe") },
      { ProcessId: 22, ParentProcessId: 2, ExecutablePath: W("D:/WindowsApps/Claude_1.0.0.0_x64__aaaaaaaaaaaaa/claude.exe") },
      { ProcessId: 23, ParentProcessId: 2, ExecutablePath: W(`D:/WindowsApps/Claude_1.0.0.0_x64__${pub}evil/claude.exe`) },
      { ProcessId: 24, ParentProcessId: 2, ExecutablePath: W("C:/Users/u/AppData/Roaming/Claude/claude-code-evil/claude.exe") },
      { ProcessId: 25, ParentProcessId: 2, ExecutablePath: W(`D:/WindowsAppsEvil/Claude_1_x64__${pub}/claude.exe`) },
      { ProcessId: 26, ParentProcessId: 2, ExecutablePath: null },
    ];
    const picked = selectAppProcesses(procs, { target, env });
    assert(picked.map((p) => p.ProcessId).join(",") === "10,11,13,12", `wrong processes selected: ${picked.map((p) => p.ProcessId)}`);
    // Stop order: the main process first, then its selected children; nothing else.
    assert(stopOrder(picked).map((p) => p.ProcessId).join(",") === "10,11,13,12", `stop order: ${stopOrder(picked).map((p) => p.ProcessId)}`);
  });

  await test("update-broker reinstalls deps until an install succeeds, and rejects unknown flags", async () => {
    const h = depsHash("pkg", "lock");
    assert(h === depsHash("pkg", "lock") && h !== depsHash("pkg", "lock2"), "hash must follow the lockfile");
    assert(depsHash("ab", "c") !== depsHash("a", "bc"), "hash must separate the two files");
    assert(!needsDepsInstall({ nodeModulesExists: true, currentHash: h, installedHash: h }), "installed and current: no reinstall");
    assert(needsDepsInstall({ nodeModulesExists: true, currentHash: h, installedHash: null }), "no marker (failed or first install) must install");
    assert(needsDepsInstall({ nodeModulesExists: true, currentHash: h, installedHash: "old" }), "changed deps must install");
    assert(needsDepsInstall({ nodeModulesExists: false, currentHash: h, installedHash: h }), "missing node_modules must install");
    const o = updaterArgs(["--restart-only", "--dry-run"]);
    assert(!o.pull && !o.tests && o.restart && o.dryRun, `restart-only parse: ${JSON.stringify(o)}`);
    const d = updaterArgs(["--deps-only"]);
    assert(d.depsOnly && !d.pull && !d.tests && !d.restart, `deps-only must install and nothing else: ${JSON.stringify(d)}`);
    assert(updaterArgs(["--restart-helper", "--log", path.resolve("x.log")]).log === path.resolve("x.log"), "--log not parsed");
    for (const bad of [["--force"], ["--log"], ["--log", "relative.log"]]) {
      let threw = false;
      try {
        updaterArgs(bad);
      } catch {
        threw = true;
      }
      assert(threw, `should reject ${bad.join(" ")}`);
    }
  });

  await test("configure-codex applies keep-awake, https-only, model and effort idempotently", async () => {
    const seed = ['model = "gpt-old"', 'model_reasoning_effort = "high"', "", "[features]", "js_repl = false", "", "[desktop]", "x = 1", ""].join("\n");
    const one = applyChanges(seed, { httpsOnly: true, model: "gpt-new", effort: "ultra", verify: false });
    assert(one.changes.length === 5, `expected 5 changes, got ${JSON.stringify(one.changes)}`);
    const r = configReport(one.text);
    assert(r.keepAwake && r.httpsBlock, `report wrong: ${JSON.stringify(r)}`);
    assert(/^model = "gpt-new"$/m.test(one.text) && !/gpt-old/.test(one.text), "model not replaced");
    assert(/^model_reasoning_effort = "ultra"$/m.test(one.text), "effort not replaced");
    assert(/^\[features\]\nprevent_idle_sleep = true\njs_repl = false$/m.test(one.text), `features block wrong:\n${one.text}`);
    assert(/^\[desktop\]\nx = 1$/m.test(one.text), "unrelated table disturbed");
    assert((one.text.match(/\[model_providers\.chatgpt_http\]/g) || []).length === 1, "provider block count");
    const two = applyChanges(one.text, { httpsOnly: true, model: "gpt-new", effort: "ultra", verify: false });
    assert(two.changes.length === 0 && two.text === one.text, `second run not a no-op: ${JSON.stringify(two.changes)}`);
    const off = applyChanges(one.text, { httpsOnly: false, model: null, effort: null, verify: false });
    assert(!/^model_provider =/m.test(off.text) && /\[model_providers\.chatgpt_http\]/.test(off.text), "no-https-only wrong");
    const empty = applyChanges("", { httpsOnly: null, model: null, effort: null, verify: false });
    assert(/^\[features\]\nprevent_idle_sleep = true\n$/m.test(empty.text.replace(/^\n+/, "")), `empty file wrong:\n${JSON.stringify(empty.text)}`);
  });

  await test("job-forensics buckets errors, correlates host events, and finds jobs across homes", async () => {
    const log = [
      "[broker] direct spawn (mode=background) at 2026-08-31T12:25:11.190Z",
      "2026-08-31T12:25:43.703104Z  INFO codex_core: session start",
      '{"type":"item.started","item":{"type":"todo_list"}}',
      "2026-08-31T12:45:04.930244Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: No such host is known. (os error 11001)",
      '{"type":"error","message":"Reconnecting... 2/5 (stream disconnected before completion: No such host is known. (os error 11001))"}',
      "2026-08-31T13:09:18.797384Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: No such host is known. (os error 11001)",
      '{"type":"item.completed","item":{"type":"error","message":"Falling back from WebSockets to HTTPS transport."}}',
      "2026-08-31T13:40:41.101915Z ERROR codex_models_manager::manager: failed to refresh available models",
      '{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}',
    ].join("\n");
    const b = errorBuckets(log);
    assert(b.map((x) => `${x.minute}:${x.count}`).join(" ") === "2026-08-31T12:45:2 2026-08-31T13:09:2 2026-08-31T13:40:2", `buckets: ${JSON.stringify(b)}`);
    const ev = [
      { ms: Date.parse("2026-08-31T12:45:05Z"), id: 507, src: "power", msg: "exiting Modern Standby" },
      { ms: Date.parse("2026-08-31T13:09:12Z"), id: 507, src: "power", msg: "exiting Modern Standby" },
      { ms: Date.parse("2026-08-31T13:40:39Z"), id: 506, src: "power", msg: "entering Modern Standby" },
    ];
    const c = correlate(b, ev, 120);
    assert(c.explained === 3 && /^HOST: 3\/3/.test(c.verdict), `verdict: ${c.verdict}`);
    const far = correlate(b, [{ ms: Date.parse("2026-08-31T10:00:00Z"), id: 507, src: "power", msg: "x" }], 120);
    assert(far.explained === 0 && /^UNEXPLAINED/.test(far.verdict), `far verdict: ${far.verdict}`);
    assert(/not possible/.test(correlate(b, [], 120).verdict), "empty-events verdict");

    // findJob searches every broker home given, by full id or unique suffix.
    const homeA = path.join(tmpRoot, "homeA");
    const homeB = path.join(tmpRoot, "homeB");
    const mk = (home, id, text) => {
      const d = path.join(home, "jobs", id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ job_id: id, jobClass: "task", mode: "background", cwd: "C:/x", createdAt: "2026-08-31T12:25:11.190Z", endedAt: "2026-08-31T13:40:53.628Z", startedAt: 1 }));
      fs.writeFileSync(path.join(d, "output.log"), text);
      fs.writeFileSync(path.join(d, "exit"), "1");
      return d;
    };
    const jobDir = mk(homeB, "20260831122511-e1a011ec", log);
    mk(homeA, "20260831121448-ab303797", "nothing here");
    const env = { CODEX_BROKER_HOME: "", CODEX_BROKER_JOBS_DIR: "" };
    assert(findJob({ id: "e1a011ec", latest: false, homes: [homeA, homeB] }, env) === jobDir, "suffix lookup across homes failed");
    assert(findJob({ id: "20260831122511-e1a011ec", latest: false, homes: [homeB] }, env) === jobDir, "full id lookup failed");
    assert(findJob({ id: "nope", latest: false, homes: [homeA, homeB] }, env) === null, "missing job should be null");
    const rep = forensicsReport(jobDir, { events: false, windowSeconds: 120 });
    assert(/window:\s+2026-08-31T12:25:11\.190Z → 2026-08-31T13:40:53\.628Z\s+\(76 min\)/.test(rep), `no window line:\n${rep}`);
    assert(/2026-08-31T12:45Z\s+x\s+2/.test(rep) && /VERDICT:/.test(rep) && /## Last 10 log lines/.test(rep), `report shape:\n${rep}`);
  });

  await test("a job that dies in a connection storm gets an automatic forensics section", async () => {
    const s = await client.call("codex_start", { prompt: "NETFAIL storm", cwd: workDir });
    const jobId = extractJobId(s.text);
    let fin = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const p = await client.call("codex_status", { job_id: jobId });
      if (/status: (completed|failed)/.test(p.text)) {
        fin = p.text;
        break;
      }
    }
    assert(fin && /status: failed \(exit 1\)/.test(fin), `expected failed: ${fin}`);
    assert(/Forensics \(auto; docs\/LESSONS\.md #9\):/.test(fin), `status lacks forensics:\n${fin}`);
    assert(/connection errors by UTC minute: \d{2}:\d{2}Z x\d+/.test(fin) && /VERDICT: /.test(fin), `forensics shape:\n${fin}`);
    const r = await client.call("codex_result", { job_id: jobId }, 60000);
    assert(r.isError && /Forensics \(auto/.test(r.text) && /full report: node scripts\/job-forensics\.mjs/.test(r.text), `result lacks forensics:\n${r.text}`);
    // A clean failure (no connection errors) gets no forensics block.
    const f = await client.call("codex_task", { prompt: "FAIL plainly", cwd: workDir, timeout_seconds: 30 }, 60000);
    assert(f.isError && !/Forensics/.test(f.text), `plain failure wrongly got forensics:\n${f.text}`);
  });

  await test("launcher runs the server from a checkout when configured, else the bundled copy", async () => {
    const repoRoot = path.join(HERE, "..", "..");
    const boot = (repo) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(HERE, "..", "launch.mjs")], { env: { ...childEnv, CODEX_BROKER_REPO: repo }, stdio: ["pipe", "pipe", "pipe"] });
        let err = "";
        const done = (v) => {
          try {
            p.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve(v);
        };
        p.stderr.on("data", (d) => {
          err += d.toString();
          if (/MCP server running/.test(err)) done(err);
        });
        setTimeout(() => done(err), 8000);
      });
    const fromCheckout = await boot(repoRoot);
    assert(/launcher: running from checkout/.test(fromCheckout) && /MCP server running/.test(fromCheckout), `checkout boot:\n${fromCheckout}`);
    const bundled = await boot(path.join(tmpRoot, "not-a-checkout"));
    assert(/launcher: running bundled server \(no server\/server\.mjs under/.test(bundled) && /MCP server running/.test(bundled), `bundled boot:\n${bundled}`);
    const none = await boot("");
    assert(/running bundled server \(no checkout configured\)/.test(none), `empty boot:\n${none}`);
  });

  // ---- v1.5.0: git_commit / git_clone / gh_read / gh_pr_create / gh_issue_create

  await test("git_commit end-to-end: stages and commits in a real repo", async () => {
    const repo = path.join(tmpRoot, "commit-repo");
    fs.mkdirSync(repo, { recursive: true });
    const g = (...a) => {
      const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    };
    g("init", "-q");
    g("config", "user.email", "test@example.invalid");
    g("config", "user.name", "Broker Test");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    const r = await client.call("git_commit", { cwd: repo, message: "test commit via broker" });
    assert(!r.isError, `expected success, got: ${r.text}`);
    const log = g("log", "--oneline");
    assert(/test commit via broker/.test(log), `commit missing from log: ${log}`);
  });

  await test("git_commit with pathspecs stages only listed paths", async () => {
    const repo = path.join(tmpRoot, "commit-repo"); // repo from prior test
    fs.writeFileSync(path.join(repo, "wanted.txt"), "yes\n");
    fs.writeFileSync(path.join(repo, "unwanted.txt"), "no\n");
    const r = await client.call("git_commit", { cwd: repo, message: "partial", paths: ["wanted.txt"] });
    assert(!r.isError, `expected success, got: ${r.text}`);
    const st = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout;
    assert(/\?\? unwanted\.txt/.test(st), `unwanted.txt should remain untracked: ${st}`);
    assert(!/wanted\.txt/.test(st.replace(/\?\? unwanted\.txt/, "")), `wanted.txt should be committed: ${st}`);
  });

  await test("git_commit rejects flag-like and escaping pathspecs", async () => {
    const r1 = await client.call("git_commit", { cwd: workDir, message: "x", paths: ["--all"] });
    assert(r1.isError && /Invalid pathspec/.test(r1.text), `expected rejection, got: ${r1.text}`);
    const r2 = await client.call("git_commit", { cwd: workDir, message: "x", paths: ["../escape.txt"] });
    assert(r2.isError && /Invalid pathspec/.test(r2.text), `expected rejection, got: ${r2.text}`);
  });

  await test("git_commit reports 'nothing to commit' as clean failure", async () => {
    const repo = path.join(tmpRoot, "clean-repo");
    fs.mkdirSync(repo, { recursive: true });
    for (const a of [["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "T"]]) {
      spawnSync("git", a, { cwd: repo });
    }
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
    const r = await client.call("git_commit", { cwd: repo, message: "empty" });
    assert(r.isError && /FAILED/.test(r.text), `expected clean failure, got: ${r.text}`);
  });

  await test("git_clone validates url and dest (https only, new absolute dest)", async () => {
    const r1 = await client.call("git_clone", { url: "ssh://git@github.com/x/y.git", dest: path.join(tmpRoot, "c1") });
    assert(r1.isError && /Invalid clone url/.test(r1.text), `ssh url should be rejected: ${r1.text}`);
    const r2 = await client.call("git_clone", { url: "file:///etc", dest: path.join(tmpRoot, "c2") });
    assert(r2.isError && /Invalid clone url/.test(r2.text), `file url should be rejected: ${r2.text}`);
    const r3 = await client.call("git_clone", { url: `file://${path.join(tmpRoot, "commit-repo")}`, dest: path.join(tmpRoot, "c3") });
    assert(r3.isError && /Invalid clone url/.test(r3.text), `local transport should be rejected: ${r3.text}`);
    const r4 = await client.call("git_clone", { url: "https://github.com/x/y.git", dest: workDir });
    assert(r4.isError && /already exists/.test(r4.text), `existing dest should be rejected: ${r4.text}`);
    const r5 = await client.call("git_clone", { url: "https://github.com/x/y.git", dest: "relative/dest" });
    assert(r5.isError && /absolute/.test(r5.text), `relative dest should be rejected: ${r5.text}`);
  });

  await test("gh_read enforces the read-only allowlist", async () => {
    const r1 = await client.call("gh_read", { args: ["api", "repos/x/y"] });
    assert(r1.isError && /not allowed/.test(r1.text), `api topic should be rejected: ${r1.text}`);
    const r2 = await client.call("gh_read", { args: ["pr", "merge", "1"] });
    assert(r2.isError && /not allowed/.test(r2.text), `merge verb should be rejected: ${r2.text}`);
    const r3 = await client.call("gh_read", { args: ["pr", "view", "--web"] });
    assert(r3.isError && /--web/.test(r3.text), `--web should be rejected: ${r3.text}`);
    const r4 = await client.call("gh_read", { args: ["issue"] });
    assert(r4.isError && /args must be an array/.test(r4.text), `short args should be rejected: ${r4.text}`);
  });

  await test("gh_read passes allowlisted argv through to gh (mock)", async () => {
    const r = await client.call("gh_read", { args: ["pr", "list", "--repo", "owner/name", "--limit", "5"], cwd: workDir });
    assert(!r.isError && /MOCKGH pr list --repo owner\/name --limit 5/.test(r.text), `unexpected: ${r.text}`);
  });

  await test("gh_pr_create validates and passes through (mock)", async () => {
    const r1 = await client.call("gh_pr_create", { cwd: workDir, title: "" });
    assert(r1.isError && /title/.test(r1.text), `empty title should be rejected: ${r1.text}`);
    const r2 = await client.call("gh_pr_create", { cwd: workDir, title: "T", base: "--force" });
    assert(r2.isError && /Invalid base/.test(r2.text), `flag base should be rejected: ${r2.text}`);
    const r3 = await client.call("gh_pr_create", { cwd: workDir, title: "Fix things", body: "b", base: "main", draft: true });
    assert(!r3.isError && /MOCKGH pr create --title Fix things --body b --base main --draft/.test(r3.text), `unexpected: ${r3.text}`);
  });

  await test("gh_issue_create validates and passes through (mock)", async () => {
    const r1 = await client.call("gh_issue_create", { cwd: workDir, title: "T", repo: "bad name" });
    assert(r1.isError && /Invalid repo/.test(r1.text), `bad repo should be rejected: ${r1.text}`);
    const r2 = await client.call("gh_issue_create", { cwd: workDir, title: "Bug", body: "details", repo: "owner/name" });
    assert(!r2.isError && /MOCKGH issue create --title Bug --body details --repo owner\/name/.test(r2.text), `unexpected: ${r2.text}`);
  });

  // --- buildGitConfigEnv: must never discard host-injected git config -------
  // Cloud hosts pre-populate GIT_CONFIG_*; overwriting index 0 silently broke
  // credential handling and url.*.insteadOf rewriting.

  await test("buildGitConfigEnv appends after inherited GIT_CONFIG entries", async () => {
    const env = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.interactive",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_1: "git@github.com:",
      GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_2: "ssh://git@github.com/",
    };
    const out = buildGitConfigEnv(env, "/work/repo");
    assert(out.GIT_CONFIG_COUNT === "4", `expected count 4, got ${out.GIT_CONFIG_COUNT}`);
    assert(out.GIT_CONFIG_KEY_3 === "safe.directory", `safe.directory should land at index 3, got ${out.GIT_CONFIG_KEY_3}`);
    assert(out.GIT_CONFIG_VALUE_3 === "/work/repo", `bad value: ${out.GIT_CONFIG_VALUE_3}`);
    // every inherited entry survives untouched
    assert(out.GIT_CONFIG_KEY_0 === "credential.interactive", "inherited key 0 was clobbered");
    assert(out.GIT_CONFIG_VALUE_1 === "git@github.com:", "inherited value 1 was clobbered");
    assert(out.GIT_CONFIG_VALUE_2 === "ssh://git@github.com/", "inherited value 2 was clobbered");
  });

  await test("buildGitConfigEnv starts at index 0 when nothing is inherited", async () => {
    for (const env of [{}, { GIT_CONFIG_COUNT: "0" }, { GIT_CONFIG_COUNT: "not-a-number" }, { GIT_CONFIG_COUNT: "-2" }]) {
      const out = buildGitConfigEnv(env, "/w");
      assert(out.GIT_CONFIG_COUNT === "1", `expected count 1 for ${JSON.stringify(env)}, got ${out.GIT_CONFIG_COUNT}`);
      assert(out.GIT_CONFIG_KEY_0 === "safe.directory", `expected index 0 for ${JSON.stringify(env)}`);
      assert(out.GIT_CONFIG_VALUE_0 === "/w", `bad value for ${JSON.stringify(env)}`);
    }
  });

  await test("git_commit keeps host GIT_CONFIG entries alongside safe.directory", async () => {
    // End to end through the server: a host-injected identity via GIT_CONFIG_*
    // must survive the broker's safe.directory injection. With the old COUNT=1
    // override the commit fell back to whatever identity git found elsewhere.
    const repo = path.join(tmpRoot, "gitcfg-repo");
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "x");
    const hostClient = new Client({
      ...childEnv,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Host Injected",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "host@example.test",
    });
    try {
      await hostClient.initialize();
      const r = await hostClient.call("git_commit", { cwd: repo, message: "host config survives" });
      assert(!r.isError, `commit failed: ${r.text}`);
    } finally {
      hostClient.close();
    }
    const who = spawnSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    assert(who === "Host Injected <host@example.test>", `inherited GIT_CONFIG identity was discarded: got "${who}"`);
  });
}

main()
  .catch((e) => {
    console.log(`FATAL ${e.stack || e}`);
    results.push({ name: "harness", ok: false, err: String(e) });
  })
  .finally(() => {
    client.close();
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n==== ${passed} passed, ${failed} failed ====`);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(failed === 0 ? 0 : 1);
  });
