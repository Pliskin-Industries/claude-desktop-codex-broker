#!/usr/bin/env node
// Idempotent editor for the Codex CLI's ~/.codex/config.toml. Run it from the
// setup sequence (CLAUDE.md step 4) so the broker's operating assumptions hold
// on every machine without a hand edit:
//
//   node scripts/configure-codex.mjs                 # ensure keep-awake
//   node scripts/configure-codex.mjs --https-only    # + HTTPS-only ChatGPT provider
//   node scripts/configure-codex.mjs --model gpt-6-astra --effort ultra
//   node scripts/configure-codex.mjs --verify        # report; exit 1 if keep-awake is off
//
// What it manages (and nothing else — every other line is preserved verbatim):
//   [features] prevent_idle_sleep = true   always ensured (docs/LESSONS.md #9)
//   model_provider / [model_providers.chatgpt_http]   with --https-only
//   model = ... / model_reasoning_effort = ...        with --model / --effort
//
// Backs up to config.toml.bak-<timestamp> before any write; no write, no
// backup. Honors CODEX_HOME (Codex's own override) for the config location.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HTTPS_PROVIDER = "chatgpt_http";
const HTTPS_BLOCK = [
  "# HTTPS-only transport for the ChatGPT backend (skips the WebSocket retry storm).",
  "# Managed by codex-broker scripts/configure-codex.mjs; see docs/LESSONS.md #9.",
  `[model_providers.${HTTPS_PROVIDER}]`,
  'name = "ChatGPT HTTP"',
  'base_url = "https://chatgpt.com/backend-api/codex"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
  "supports_websockets = false",
];

export function parseArgs(argv) {
  const opts = { httpsOnly: null, model: null, effort: null, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--https-only") opts.httpsOnly = true;
    else if (a === "--no-https-only") opts.httpsOnly = false;
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--effort") opts.effort = argv[++i];
    else if (a === "--verify") opts.verify = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const k of ["model", "effort"]) {
    if (opts[k] !== null && (typeof opts[k] !== "string" || opts[k].trim() === "" || /[\s"\\]/.test(opts[k]))) {
      throw new Error(`--${k} needs a plain value (no spaces or quotes)`);
    }
  }
  return opts;
}

export function configPath(env = process.env) {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(os.homedir(), ".codex");
  return path.join(home, "config.toml");
}

// --- TOML line surgery ------------------------------------------------------
// The file is treated as: preamble (top-level keys, before the first [table])
// followed by tables. Only whole lines are ever replaced or inserted.

function splitLines(text) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(/\r?\n/), nl };
}

function isHeader(line) {
  return /^\s*\[/.test(line);
}

function keyRe(key) {
  return new RegExp(`^\\s*${key.replace(/\./g, "\\.")}\\s*=`);
}

// Set a top-level key: replace it in the preamble or insert at the very top.
function setTopLevel(lines, key, valueToml) {
  const firstHeader = lines.findIndex(isHeader);
  const end = firstHeader === -1 ? lines.length : firstHeader;
  const rendered = `${key} = ${valueToml}`;
  for (let i = 0; i < end; i++) {
    if (keyRe(key).test(lines[i])) {
      if (lines[i] === rendered) return false;
      lines[i] = rendered;
      return true;
    }
  }
  lines.unshift(rendered);
  return true;
}

function removeTopLevel(lines, key) {
  const firstHeader = lines.findIndex(isHeader);
  const end = firstHeader === -1 ? lines.length : firstHeader;
  for (let i = 0; i < end; i++) {
    if (keyRe(key).test(lines[i])) {
      lines.splice(i, 1);
      return true;
    }
  }
  return false;
}

// Set a key inside [table]; create the table at the end if absent.
function setInTable(lines, table, key, valueToml) {
  const rendered = `${key} = ${valueToml}`;
  const headerRe = new RegExp(`^\\s*\\[${table.replace(/\./g, "\\.")}\\]\\s*$`);
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", `[${table}]`, rendered);
    return true;
  }
  let end = lines.findIndex((l, i) => i > start && isHeader(l));
  if (end === -1) end = lines.length;
  for (let i = start + 1; i < end; i++) {
    if (keyRe(key).test(lines[i])) {
      if (lines[i] === rendered) return false;
      lines[i] = rendered;
      return true;
    }
  }
  lines.splice(start + 1, 0, rendered);
  return true;
}

function hasTable(lines, table) {
  const headerRe = new RegExp(`^\\s*\\[${table.replace(/\./g, "\\.")}\\]\\s*$`);
  return lines.some((l) => headerRe.test(l));
}

export function applyChanges(text, opts) {
  const { lines, nl } = splitLines(text);
  const changes = [];

  if (setInTable(lines, "features", "prevent_idle_sleep", "true")) changes.push("features.prevent_idle_sleep = true");

  if (opts.httpsOnly === true) {
    if (!hasTable(lines, `model_providers.${HTTPS_PROVIDER}`)) {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("", ...HTTPS_BLOCK);
      changes.push(`[model_providers.${HTTPS_PROVIDER}] added`);
    }
    if (setTopLevel(lines, "model_provider", `"${HTTPS_PROVIDER}"`)) changes.push(`model_provider = "${HTTPS_PROVIDER}"`);
  } else if (opts.httpsOnly === false) {
    if (removeTopLevel(lines, "model_provider")) changes.push("model_provider removed (provider block kept)");
  }

  if (opts.model && setTopLevel(lines, "model", `"${opts.model}"`)) changes.push(`model = "${opts.model}"`);
  if (opts.effort && setTopLevel(lines, "model_reasoning_effort", `"${opts.effort}"`)) {
    changes.push(`model_reasoning_effort = "${opts.effort}"`);
  }

  let out = lines.join(nl);
  if (!out.endsWith(nl)) out += nl;
  return { text: out, changes };
}

export function report(text) {
  const { lines } = splitLines(text);
  const get = (re) => {
    const l = lines.find((x) => re.test(x));
    return l ? l.trim() : "(unset)";
  };
  const featuresStart = lines.findIndex((l) => /^\s*\[features\]\s*$/.test(l));
  let keepAwake = false;
  if (featuresStart !== -1) {
    for (let i = featuresStart + 1; i < lines.length && !isHeader(lines[i]); i++) {
      if (/^\s*prevent_idle_sleep\s*=\s*true\s*$/.test(lines[i])) keepAwake = true;
    }
  }
  return {
    keepAwake,
    model: get(/^\s*model\s*=/),
    effort: get(/^\s*model_reasoning_effort\s*=/),
    provider: get(/^\s*model_provider\s*=/),
    httpsBlock: hasTable(lines, `model_providers.${HTTPS_PROVIDER}`),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = configPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  if (opts.verify) {
    const r = report(existing);
    console.log(`config: ${file}`);
    console.log(`keep-awake (features.prevent_idle_sleep): ${r.keepAwake ? "on" : "OFF"}`);
    console.log(`${r.model}\n${r.effort}\n${r.provider}`);
    console.log(`https-only provider block present: ${r.httpsBlock}`);
    process.exit(r.keepAwake ? 0 : 1);
  }

  const { text, changes } = applyChanges(existing, opts);
  if (changes.length === 0) {
    console.log(`config: ${file}\nno changes needed`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existing) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
    console.log(`backup: ${backup}`);
  }
  fs.writeFileSync(file, text);
  console.log(`config: ${file}`);
  for (const c of changes) console.log(`  set ${c}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`configure-codex: ${e.message}`);
    process.exit(2);
  }
}
