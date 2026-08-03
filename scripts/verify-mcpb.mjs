#!/usr/bin/env node
// Functional smoke test for a built dist/codex-broker.mcpb.
//
// Unpacks the archive to a temp dir and drives the packaged server over real
// stdio JSON-RPC — initialize, then tools/list — asserting every tool named in
// manifest.json is actually served. This is the gate that matters: it proves the
// package a user installs will start and expose its tools, which a file-list
// comparison against a hand-built artifact never could.
//
// Usage: node scripts/verify-mcpb.mjs [path/to/codex-broker.mcpb]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCPB = process.argv[2] || path.join(ROOT, "dist", "codex-broker.mcpb");

function die(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(MCPB)) die(`no such file: ${MCPB}`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-verify-"));
process.on("exit", () => fs.rmSync(stage, { recursive: true, force: true }));

const unzip = spawnSync("unzip", ["-q", "-o", MCPB, "-d", stage], { encoding: "utf8" });
if (unzip.status !== 0) die(`unzip failed: ${unzip.stderr || unzip.status}`);

// The manifest is the contract: whatever it advertises, the server must serve.
const manifestPath = path.join(stage, "manifest.json");
if (!fs.existsSync(manifestPath)) die("manifest.json missing from package");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const declared = (manifest.tools || []).map((t) => t.name).sort();

const entry = path.join(stage, "server", "server.mjs");
if (!fs.existsSync(entry)) die("server/server.mjs missing from package");

// Job state must not leak into the real home dir during verification.
const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CODEX_BROKER_HOME: path.join(stage, "broker-home") },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // non-JSON noise on stdout is not expected, but never fatal here
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let stderr = "";
child.stderr.on("data", (c) => (stderr += c));

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-mcpb", version: "0" },
  });
  if (init.error) die(`initialize errored: ${JSON.stringify(init.error)}`);
  const version = init.result?.serverInfo?.version;
  if (version !== manifest.version) {
    die(`version mismatch: manifest.json says ${manifest.version}, server reports ${version}`);
  }

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await call("tools/list", {});
  if (listed.error) die(`tools/list errored: ${JSON.stringify(listed.error)}`);
  const served = (listed.result?.tools || []).map((t) => t.name).sort();

  const missing = declared.filter((n) => !served.includes(n));
  const extra = served.filter((n) => !declared.includes(n));
  if (missing.length) die(`declared in manifest but not served: ${missing.join(", ")}`);
  if (extra.length) die(`served but not declared in manifest: ${extra.join(", ")}`);

  console.log(`PASS: package starts, reports v${version}, serves all ${served.length} declared tools`);
  console.log(`      ${served.join(" ")}`);
} catch (err) {
  die(`${err.message}${stderr ? `\n--- server stderr ---\n${stderr}` : ""}`);
} finally {
  child.kill("SIGKILL");
}
