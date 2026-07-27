#!/usr/bin/env node
// Integration tests: spawn server.mjs and talk to it over real stdio JSON-RPC
// (MCP newline-delimited framing). A mock `codex` is placed first on PATH so no
// network/OpenAI access is needed. Prints PASS/FAIL per case; exit 1 if any fail.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeCodexBinary,
  locateWindowsCodexExe,
  windowsModuleDirs,
} from "../lib/util.mjs";
import { buildTaskArgs } from "../lib/codex.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.mjs");
const MOCK = path.join(HERE, "mock-codex");

// --- Test environment setup ------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-test-"));
const binDir = path.join(tmpRoot, "bin");
const brokerHome = path.join(tmpRoot, "broker-home");
const workDir = path.join(tmpRoot, "work"); // codex cwd (need not be a git repo)
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(brokerHome, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

// Place the mock first on PATH as `codex`.
const codexLink = path.join(binDir, "codex");
fs.copyFileSync(MOCK, codexLink);
fs.chmodSync(codexLink, 0o755);

// Mock gh for the v1.5.0 gh_* pass-through tests: echoes its argv.
const mockGh = path.join(binDir, "gh");
fs.writeFileSync(mockGh, '#!/bin/sh\necho "MOCKGH $@"\n');
fs.chmodSync(mockGh, 0o755);

const childEnv = {
  ...process.env,
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  CODEX_BROKER_HOME: brokerHome,
  GH_BIN: mockGh,
  // Ensure no ambient overrides leak in.
  CODEX_BIN: "",
  CODEX_MODEL: "",
};

// --- Minimal MCP stdio JSON-RPC client -------------------------------------
class Client {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
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
  await runWindowsResolutionTests();

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
