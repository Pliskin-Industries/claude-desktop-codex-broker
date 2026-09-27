#!/usr/bin/env node
// Preflight for the Codex broker: checks everything the broker needs, in the
// order it fails in the field, and says how to fix each problem.
//
//   node scripts/doctor.mjs          # human-readable report; exit 1 if anything required fails
//   node scripts/doctor.mjs --json   # machine-readable report
//   node scripts/doctor.mjs --plugin # as run by the plugin's /codex-broker:setup
//
// Every check here maps to a failure that has cost real time (docs/LESSONS.md):
// a Codex CLI too old for the configured model, a login that lapsed, the
// Windows sandbox never provisioned (#11: READY passes, every command is
// "blocked by policy"), keep-awake off (#9), a binary that is installed but
// invisible to an app started before the install (#10).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeCodexBinary } from "../server/lib/util.mjs";
import { configPath, report as codexConfigReport } from "./configure-codex.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export const MIN_NODE = [18, 18, 0];
// First Codex CLI whose model catalog accepts gpt-6-astra (CLAUDE.md step 1).
export const MIN_CODEX = [0, 153, 1];

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || "");
  return m ? m.slice(1, 4).map(Number) : null;
}

export function versionAtLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

// Reads `codex doctor --json` (schemaVersion 1, codex-cli 0.157.1): the
// sandbox.helpers check carries "sandbox backend" and "sandbox provisioning".
export function sandboxVerdict(doctorJson, platform) {
  if (platform !== "win32") return { status: "ok", summary: "not Windows; Codex uses the OS sandbox" };
  const details = doctorJson?.checks?.["sandbox.helpers"]?.details;
  if (!details) return { status: "warn", summary: "codex doctor did not report sandbox details; check `codex doctor` by hand" };
  const backend = details["sandbox backend"];
  const provisioning = details["sandbox provisioning"];
  if (backend === "elevated" && provisioning === "complete") {
    return { status: "ok", summary: "elevated sandbox, provisioning complete" };
  }
  return {
    status: "fail",
    summary: `sandbox backend ${backend || "unset"}, provisioning ${provisioning || "unknown"}: Codex cannot run commands`,
    fix:
      "Once, from an administrator PowerShell: " +
      '& "$env:APPDATA\\npm\\codex.cmd" sandbox setup --elevated --current-user ' +
      "(then close that window). docs/LESSONS.md #11.",
  };
}

// Required checks fail the run; optional ones only warn.
export function exitCode(results) {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

// --- probes -------------------------------------------------------------------

function probe(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60000 });
  return { ok: !r.error && r.status === 0, status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`.trim(), error: r.error };
}

function checkNode() {
  const v = parseVersion(process.version);
  return versionAtLeast(v, MIN_NODE)
    ? { id: "node", status: "ok", summary: process.version }
    : { id: "node", status: "fail", summary: `${process.version} is older than 18.18`, fix: "winget install OpenJS.NodeJS.LTS, then open a new terminal" };
}

function checkServerDeps() {
  const req = createRequire(path.join(ROOT, "server", "server.mjs"));
  try {
    req.resolve("@modelcontextprotocol/sdk/server/index.js");
    return { id: "server-deps", status: "ok", summary: "@modelcontextprotocol/sdk resolves from server/" };
  } catch {
    return { id: "server-deps", status: "fail", summary: "@modelcontextprotocol/sdk not installed; the broker cannot start", fix: "npm ci --prefix server (from the broker checkout)" };
  }
}

function checkCodex() {
  let bin;
  try {
    bin = computeCodexBinary();
  } catch (e) {
    return { codex: { id: "codex", status: "fail", summary: e.message, fix: "fix or unset CODEX_BIN" } };
  }
  const v = probe(bin, ["--version"]);
  if (!v.ok) {
    return {
      codex: {
        id: "codex",
        status: "fail",
        summary: `cannot run ${bin}: ${v.error ? v.error.code || v.error.message : v.out}`,
        fix:
          "npm install -g @openai/codex@latest. If it is installed and this still fails inside Claude, " +
          "the app started before the install: node scripts/update-broker.mjs --restart-only (docs/LESSONS.md #10)",
      },
    };
  }
  const version = parseVersion(v.out);
  const codex = versionAtLeast(version, MIN_CODEX)
    ? { id: "codex", status: "ok", summary: `${v.out} (${bin})` }
    : { id: "codex", status: "fail", summary: `${v.out} is older than ${MIN_CODEX.join(".")}`, fix: "npm install -g @openai/codex@latest" };
  return { codex, bin };
}

function checkLogin(bin) {
  const r = probe(bin, ["login", "status"]);
  return r.ok
    ? { id: "codex-login", status: "ok", summary: r.out.split(/\r?\n/)[0] }
    : { id: "codex-login", status: "fail", summary: "not logged in", fix: "run `codex login` yourself (interactive; use codex.cmd in PowerShell)" };
}

function checkSandbox(bin) {
  const r = probe(bin, ["doctor", "--json"]);
  let json = null;
  try {
    json = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    /* fall through to the verdict's own "no details" case */
  }
  return { id: "codex-sandbox", ...sandboxVerdict(json, process.platform) };
}

function checkCodexConfig() {
  const file = configPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const r = codexConfigReport(text);
  return r.keepAwake
    ? { id: "codex-config", status: "ok", summary: `keep-awake on; ${r.model}; ${r.effort}` }
    : {
        id: "codex-config",
        status: "warn",
        summary: "keep-awake is off: a sleeping laptop kills long jobs",
        fix: "node scripts/configure-codex.mjs --model gpt-6-astra --effort ultra (docs/LESSONS.md #9)",
      };
}

function checkGit() {
  const r = probe("git", ["--version"]);
  return r.ok ? { id: "git", status: "ok", summary: r.out } : { id: "git", status: "fail", summary: "git not on PATH", fix: "winget install Git.Git" };
}

function checkGh() {
  const v = probe("gh", ["--version"]);
  if (!v.ok) return { id: "gh", status: "warn", summary: "GitHub CLI not found; only the gh_* tools need it", fix: "winget install GitHub.cli, then gh auth login" };
  const auth = probe("gh", ["auth", "status"]);
  return auth.ok
    ? { id: "gh", status: "ok", summary: v.out.split(/\r?\n/)[0] + ", logged in" }
    : { id: "gh", status: "warn", summary: "GitHub CLI not logged in", fix: "gh auth login" };
}

function checkSkill(viaPlugin) {
  if (viaPlugin) return { id: "skill", status: "ok", summary: "provided by the codex-broker plugin" };
  const installed = path.join(os.homedir(), ".claude", "skills", "codex-delegation", "SKILL.md");
  if (!fs.existsSync(installed)) {
    return { id: "skill", status: "warn", summary: "codex-delegation skill not in ~/.claude/skills (not needed with the plugin)", fix: "install the plugin, or copy skill/ to ~/.claude/skills/codex-delegation" };
  }
  const same = fs.readFileSync(installed, "utf8").replace(/\r\n/g, "\n") === fs.readFileSync(path.join(ROOT, "skill", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  return same
    ? { id: "skill", status: "ok", summary: "~/.claude/skills/codex-delegation matches this checkout" }
    : { id: "skill", status: "warn", summary: "~/.claude/skills/codex-delegation differs from this checkout", fix: "copy skill/ over it again (skill and broker version together)" };
}

export function runChecks({ viaPlugin = false } = {}) {
  const results = [checkNode(), checkServerDeps()];
  const { codex, bin } = checkCodex();
  results.push(codex);
  if (bin && codex.status !== "fail") results.push(checkLogin(bin), checkSandbox(bin));
  results.push(checkCodexConfig(), checkGit(), checkGh(), checkSkill(viaPlugin));
  return results;
}

function main() {
  const json = process.argv.includes("--json");
  // --plugin: run from the plugin's setup skill, which supplies the skill itself.
  const results = runChecks({ viaPlugin: process.argv.includes("--plugin") });
  if (json) {
    console.log(JSON.stringify({ ok: exitCode(results) === 0, results }, null, 2));
  } else {
    const mark = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
    for (const r of results) {
      console.log(`${mark[r.status]}  ${r.id.padEnd(13)} ${r.summary}`);
      if (r.fix && r.status !== "ok") console.log(`${" ".repeat(20)}fix: ${r.fix}`);
    }
    console.log(exitCode(results) === 0 ? "\nReady." : "\nNot ready: fix the FAIL lines above, then run this again.");
  }
  process.exit(exitCode(results));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
