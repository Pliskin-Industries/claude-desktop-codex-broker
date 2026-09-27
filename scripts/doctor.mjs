#!/usr/bin/env node
// Preflight for the Codex broker: checks everything the broker needs, in the
// order it fails in the field, and says how to fix each problem.
//
//   node scripts/doctor.mjs          # human-readable report; exit 1 if anything required fails
//   node scripts/doctor.mjs --json   # machine-readable report
//   node scripts/doctor.mjs --plugin # as run by the plugin's /codex-broker:setup
//   node scripts/doctor.mjs --claude-model claude-opus-5-5   # also verify that model's saved effort
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
// model hierarchy). `settings` is the active Claude Code settings.json. Two
// things make "newest" automatic: the `opus` alias (a full id stays pinned) and
// a saved High effort for the model actually running (effort is saved per model
// id; from Opus 5.5 on a top-level effortLevel is ignored and each new model
// starts at its own default, medium for Opus 5.5). The doctor can't know which
// id the alias resolves to, so the effort check needs `runningModel` (the
// setup skill passes the session's own id); without it the effort is reported
// as unverified rather than passed.
export function claudeModelVerdict(settings, env = {}, { runningModel = null, settingsFile = "~/.claude/settings.json" } = {}) {
  const problems = [];
  const fixes = [];
  const model = settings?.model;
  if (!model) problems.push("no default model set; sessions use the plan default");
  else if (/^claude-/.test(model)) problems.push(`model pinned to ${model}; it won't move to a newer release`);
  else if (!["opus", "opus[1m]"].includes(model)) problems.push(`default model is "${model}"; the orchestrator should be Opus`);
  if (problems.length) fixes.push(`"model": "opus" in ${settingsFile}`);
  const saved = (id) => settings?.modelSettings?.[id]?.effortLevel;
  const envEffort = env.CLAUDE_CODE_EFFORT_LEVEL;
  const effortFix = "on each new Opus or Fable, in a session: /effort high, then Enter (saves it for that model)";
  if (envEffort && envEffort !== "high") {
    problems.push(`CLAUDE_CODE_EFFORT_LEVEL=${envEffort} overrides every saved effort`);
    fixes.push("unset CLAUDE_CODE_EFFORT_LEVEL, or set it to high");
  }
  if (!envEffort) {
    if (!runningModel) {
      problems.push("effort of the running model not verified");
      fixes.push("run /codex-broker:setup, or re-run with --claude-model <the session's model id>");
    } else if (!/^claude-(opus|fable)-/.test(runningModel)) {
      problems.push(`this session runs ${runningModel}; the orchestrator should be the newest Opus (or Fable for rulings)`);
      fixes.push("/model opus in Claude Code, or the app's model picker");
    } else if (saved(runningModel) !== "high") {
      problems.push(`${runningModel} effort is ${saved(runningModel) || "unset, so it runs at its own default"}`);
      fixes.push(effortFix);
    }
  }
  const fix = fixes.join("; ");
  const summary = [
    model ? `model ${model}` : null,
    runningModel ? `${runningModel} effort ${envEffort ? `${envEffort} (env)` : saved(runningModel) || "unset"}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return problems.length ? { status: "warn", summary: problems.join("; "), fix } : { status: "ok", summary: `${summary} (the alias tracks the newest Opus)` };
}

// The executor's required default effort (skill/SKILL.md; configure-codex).
export const EXECUTOR_EFFORT = "ultra";

// Rank Codex's catalog (~/.codex/models_cache.json). Only models Codex lists,
// that the API supports, and that carry a numeric priority can be ranked; lower
// priority = ranked higher; ties share a rank.
export function rankCatalog(catalog) {
  return (catalog?.models || [])
    .filter((m) => m && m.visibility === "list" && m.supported_in_api !== false && Number.isFinite(m.priority) && m.slug)
    .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
}

// Codex's executor should be the top of the catalog at `ultra` by default. The
// model the broker actually uses is CODEX_MODEL when set (resolveModel in
// server/lib/util.mjs), else config.toml. The relief executor is the next-ranked
// model after the executor; it is reported so it is never hardcoded.
export function codexModelVerdict({ model, effort, envModel = null }, catalog) {
  const ranked = rankCatalog(catalog);
  if (ranked.length === 0) {
    return { status: "warn", summary: "Codex's model catalog isn't cached, or no model in it can be ranked", fix: "run any codex command once, then re-run this check" };
  }
  const tops = ranked.filter((m) => m.priority === ranked[0].priority);
  const topSlug = tops[0].slug;
  const switchFix = `node scripts/configure-codex.mjs --model ${topSlug} --effort ${EXECUTOR_EFFORT} (tell the user; never switch silently)`;
  const problems = [];
  const effective = envModel || model;
  if (envModel) problems.push(`CODEX_MODEL=${envModel} overrides config.toml for delegations without an explicit model`);
  if (!effective) {
    return { status: "warn", summary: `no model in config.toml; the newest is ${topSlug}`, fix: switchFix };
  }
  const mine = ranked.find((m) => m.slug === effective);
  if (!mine) {
    const known = (catalog.models || []).find((m) => m.slug === effective);
    const why = known ? "is hidden, unsupported in the API, or unranked in Codex's catalog" : "is not in Codex's catalog (misspelled or retired)";
    return { status: "warn", summary: `${effective} ${why}; the newest is ${topSlug}`, fix: switchFix };
  }
  if (!tops.includes(mine)) problems.push(`newer model available: ${topSlug} (${tops[0].display_name || topSlug})`);
  const levels = (mine.supported_reasoning_levels || []).map((l) => l?.effort).filter(Boolean);
  if (!effort) problems.push(`no default effort in config.toml; the hierarchy's default is ${EXECUTOR_EFFORT}`);
  else if (effort !== EXECUTOR_EFFORT) problems.push(`default effort is ${effort}; the hierarchy's default is ${EXECUTOR_EFFORT}`);
  if (levels.length === 0) problems.push(`the catalog lists no effort levels for ${effective}, so ${effort || EXECUTOR_EFFORT} can't be verified`);
  else if (effort && !levels.includes(effort)) problems.push(`effort "${effort}" isn't supported by ${effective} (${levels.join(", ")})`);
  if (mine.upgrade?.retirement_at) problems.push(`${effective} retires ${String(mine.upgrade.retirement_at).slice(0, 10)}`);
  const relief = ranked.find((m) => m.slug !== mine.slug)?.slug || null;
  const reliefNote = relief ? `; relief: ${relief}` : "";
  return problems.length
    ? { status: "warn", summary: problems.join("; ") + reliefNote, fix: switchFix, relief }
    : { status: "ok", summary: `${effective} at ${effort} is the newest in Codex's catalog${reliefNote}`, relief };
}

// The value of a top-level string key in TOML: only lines before the first
// [table], a basic "..." or literal '...' string, trailing comment allowed.
export function tomlTopLevelString(text, key) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    const m = new RegExp(`^${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')\\s*(?:#.*)?$`).exec(line);
    if (m) return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
  }
  return null;
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

function checkClaudeModel(runningModel) {
  // Claude Code reads settings from CLAUDE_CONFIG_DIR when set.
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const file = path.join(dir, "settings.json");
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      return { id: "claude-model", status: "warn", summary: `${file} isn't valid JSON (${e.message}); Claude Code may be ignoring it`, fix: `fix the JSON in ${file}` };
    }
  }
  return { id: "claude-model", ...claudeModelVerdict(settings, process.env, { runningModel, settingsFile: file }) };
}

function checkCodexModel() {
  const file = configPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const catalog = readJsonOr(path.join(path.dirname(file), "models_cache.json"), null);
  const envModel = (process.env.CODEX_MODEL || "").trim() || null;
  const verdict = codexModelVerdict(
    { model: tomlTopLevelString(text, "model"), effort: tomlTopLevelString(text, "model_reasoning_effort"), envModel },
    catalog
  );
  return { id: "codex-model", ...verdict };
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

export function runChecks({ viaPlugin = false, claudeModel = null } = {}) {
  const results = [checkNode(), checkServerDeps(viaPlugin)];
  const { codex, bin } = checkCodex();
  results.push(codex);
  if (bin && codex.status !== "fail") results.push(checkLogin(bin), checkSandbox(bin));
  results.push(checkCodexConfig(), checkCodexModel(), checkClaudeModel(claudeModel), checkGit(), checkGh(), checkSkill(viaPlugin));
  return results;
}

function main() {
  const json = process.argv.includes("--json");
  // --plugin: run from the plugin's setup skill, which supplies the skill itself.
  // --claude-model <id>: the running session's model id, so its saved effort
  // can be checked (the doctor can't resolve what the `opus` alias points to).
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--claude-model");
  const claudeModel = at >= 0 ? argv[at + 1] || null : null;
  const results = runChecks({ viaPlugin: argv.includes("--plugin"), claudeModel });
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
