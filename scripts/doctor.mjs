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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeCodexBinary, resolveGhBinary, resolveGitBinary } from "../server/lib/util.mjs";
import { configPath, report as codexConfigReport } from "./configure-codex.mjs";
import { depsHash } from "./update-broker.mjs";

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
  // Fail closed: an unreadable verdict is not evidence the sandbox works, and
  // "Ready" over a missing sandbox is exactly the silent failure of LESSONS #11.
  if (!details) {
    return {
      status: "fail",
      summary: "could not read the sandbox state from `codex doctor --json`",
      fix: "run `codex.cmd doctor` and check its sandbox section shows backend elevated, provisioning complete",
    };
  }
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

// The orchestrator should be the newest Opus at High effort (skill/SKILL.md,
// model hierarchy). settings is ~/.claude/settings.json. The doctor can't know
// which Opus is newest, so it checks the two things that make that automatic:
// the `opus` alias (a full id stays pinned) and a saved High effort per model
// (from Opus 5.5 on, a top-level effortLevel is ignored and each new model
// starts at its own default, medium for Opus 5.5).
export function claudeModelVerdict(settings, env = {}) {
  const problems = [];
  const model = settings?.model;
  if (!model) problems.push("no default model set; sessions use the plan default");
  else if (/^claude-/.test(model)) problems.push(`model pinned to ${model}; it won't move to a newer release`);
  else if (!["opus", "opus[1m]"].includes(model)) problems.push(`default model is "${model}"; the orchestrator should be Opus`);
  const efforts = Object.entries(settings?.modelSettings || {})
    .filter(([id]) => /^claude-(opus|fable)-/.test(id))
    .map(([id, v]) => [id, v?.effortLevel]);
  const notHigh = efforts.filter(([, e]) => e !== "high");
  if (efforts.length === 0) problems.push("no saved effort for Opus or Fable (Opus 5.5 starts at medium)");
  for (const [id, e] of notHigh) problems.push(`${id} effort is ${e || "unset"}`);
  const fix = ['"model": "opus" in ~/.claude/settings.json', "in a session on each new Opus or Fable: /effort high, then Enter"];
  if (env.CLAUDE_CODE_EFFORT_LEVEL) {
    problems.push(`CLAUDE_CODE_EFFORT_LEVEL=${env.CLAUDE_CODE_EFFORT_LEVEL} overrides every saved effort`);
  }
  const summary = [model ? `model ${model}` : null, ...efforts.map(([id, e]) => `${id} ${e || "unset"}`)].filter(Boolean).join("; ");
  return problems.length
    ? { status: "warn", summary: problems.join("; "), fix: fix.join("; ") }
    : { status: "ok", summary: `${summary} (the alias tracks the newest Opus)` };
}

// Codex's executor should be the top model of Codex's own catalog
// (~/.codex/models_cache.json: lower `priority` = ranked higher). Also checks
// the configured effort is one the model supports, and flags a model that
// Codex has scheduled for retirement.
export function codexModelVerdict({ model, effort }, catalog) {
  const listed = (catalog?.models || []).filter((m) => m.visibility === "list" && m.supported_in_api !== false);
  if (listed.length === 0) {
    return { status: "warn", summary: "Codex's model catalog isn't cached yet", fix: "run any codex command once, then re-run this check" };
  }
  const top = [...listed].sort((a, b) => a.priority - b.priority)[0];
  if (!model) {
    return { status: "warn", summary: `no model in config.toml; the newest is ${top.slug}`, fix: `node scripts/configure-codex.mjs --model ${top.slug} --effort ultra` };
  }
  const mine = (catalog.models || []).find((m) => m.slug === model);
  if (!mine) {
    return { status: "warn", summary: `${model} is not in Codex's catalog (misspelled or retired); the newest is ${top.slug}`, fix: `node scripts/configure-codex.mjs --model ${top.slug} --effort ultra` };
  }
  const problems = [];
  if (mine.slug !== top.slug && mine.priority > top.priority) problems.push(`newer model available: ${top.slug} (${top.display_name || top.slug})`);
  const levels = (mine.supported_reasoning_levels || []).map((l) => l.effort);
  if (effort && levels.length && !levels.includes(effort)) problems.push(`effort "${effort}" isn't supported by ${model} (${levels.join(", ")})`);
  if (mine.upgrade?.retirement_at) problems.push(`${model} retires ${mine.upgrade.retirement_at.slice(0, 10)}`);
  return problems.length
    ? { status: "warn", summary: problems.join("; "), fix: `node scripts/configure-codex.mjs --model ${top.slug} --effort ultra (tell the user; never switch silently)` }
    : { status: "ok", summary: `${model} at ${effort || "its default effort"} is the newest in Codex's catalog` };
}

// Required checks fail the run; optional ones only warn.
export function exitCode(results) {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

// --- probes -------------------------------------------------------------------

function probe(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60000, ...opts });
  const stdout = (r.stdout || "").trim();
  const stderr = (r.stderr || "").trim();
  return { ok: !r.error && r.status === 0, status: r.status, stdout, stderr, out: [stdout, stderr].filter(Boolean).join("\n"), error: r.error };
}

function checkNode() {
  const v = parseVersion(process.version);
  return versionAtLeast(v, MIN_NODE)
    ? { id: "node", status: "ok", summary: process.version }
    : { id: "node", status: "fail", summary: `${process.version} is older than 18.18`, fix: "winget install OpenJS.NodeJS.LTS, then open a new terminal" };
}

// Load the SDK the way the server does (ESM, resolved from server/), so a
// partial install that left the entry file but not its dependencies fails
// here instead of at broker start.
function checkServerDeps(viaPlugin) {
  const load = probe(
    process.execPath,
    ["--input-type=module", "-e", 'await import("@modelcontextprotocol/sdk/server/index.js"); await import("@modelcontextprotocol/sdk/server/stdio.js");'],
    { cwd: path.join(ROOT, "server") }
  );
  if (!load.ok) {
    return {
      id: "server-deps",
      status: "fail",
      summary: `the MCP SDK does not load from server/: ${(load.stderr.split(/\r?\n/).find((l) => /Error/.test(l)) || load.out || "unknown error").slice(0, 200)}`,
      fix: viaPlugin
        ? 'npm ci --ignore-scripts --prefix "<plugin root>", then /reload-plugins'
        : "node scripts/update-broker.mjs --deps-only (from the broker checkout)",
    };
  }
  // The plugin's install is Claude Code's own `npm ci` from the lockfile; a
  // checkout's is recorded by update-broker with a fingerprint of the lockfile.
  if (viaPlugin) return { id: "server-deps", status: "ok", summary: "MCP SDK loads" };
  const fresh = depsFreshness();
  return fresh === "current"
    ? { id: "server-deps", status: "ok", summary: "MCP SDK loads; installed from the current lockfile" }
    : {
        id: "server-deps",
        status: "warn",
        summary: fresh === "stale" ? "installed from an older lockfile" : "MCP SDK loads, but the install isn't recorded against the lockfile",
        fix: "node scripts/update-broker.mjs --deps-only (reinstalls from the lockfile and records it)",
      };
}

function depsFreshness() {
  const server = path.join(ROOT, "server");
  try {
    const current = depsHash(fs.readFileSync(path.join(server, "package.json")), fs.readFileSync(path.join(server, "package-lock.json")));
    const installed = JSON.parse(fs.readFileSync(path.join(server, "node_modules", ".codex-broker-deps.json"), "utf8")).hash;
    return installed === current ? "current" : "stale";
  } catch {
    return "unrecorded";
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
    json = JSON.parse(r.stdout); // stdout only: a stderr diagnostic must not corrupt the JSON
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

// git and gh are probed through the broker's own resolvers, so GIT_BIN /
// GH_BIN overrides and the Windows install-location search are what's checked.
function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function checkClaudeModel() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return { id: "claude-model", ...claudeModelVerdict(readJsonOr(path.join(dir, "settings.json"), {}), process.env) };
}

function checkCodexModel() {
  const file = configPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const quoted = (line) => /"([^"]*)"/.exec(line || "")?.[1] || null;
  const r = codexConfigReport(text);
  const catalog = readJsonOr(path.join(path.dirname(file), "models_cache.json"), null);
  return { id: "codex-model", ...codexModelVerdict({ model: quoted(r.model), effort: quoted(r.effort) }, catalog) };
}

function checkGit() {
  let bin;
  try {
    bin = resolveGitBinary();
  } catch (e) {
    return { id: "git", status: "fail", summary: e.message, fix: "fix or unset GIT_BIN" };
  }
  const r = probe(bin, ["--version"]);
  return r.ok ? { id: "git", status: "ok", summary: `${r.stdout} (${bin})` } : { id: "git", status: "fail", summary: `cannot run ${bin}`, fix: "winget install Git.Git" };
}

function checkGh() {
  let bin;
  try {
    bin = resolveGhBinary();
  } catch (e) {
    return { id: "gh", status: "warn", summary: e.message, fix: "fix or unset GH_BIN" };
  }
  const v = probe(bin, ["--version"]);
  if (!v.ok) return { id: "gh", status: "warn", summary: "GitHub CLI not found; only the gh_* tools need it", fix: "winget install GitHub.cli, then gh auth login" };
  const auth = probe(bin, ["auth", "status"]);
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
  const results = [checkNode(), checkServerDeps(viaPlugin)];
  const { codex, bin } = checkCodex();
  results.push(codex);
  if (bin && codex.status !== "fail") results.push(checkLogin(bin), checkSandbox(bin));
  results.push(checkCodexConfig(), checkCodexModel(), checkClaudeModel(), checkGit(), checkGh(), checkSkill(viaPlugin));
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
