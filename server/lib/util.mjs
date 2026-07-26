// Shared helpers: validation, output truncation, model/sandbox resolution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ALLOWED_SANDBOXES = ["read-only", "workspace-write"];
export const DEFAULT_SANDBOX = "workspace-write";
export const MAX_OUTPUT_CHARS = 8000;

// --- Codex binary resolution ----------------------------------------------
//
// On Windows, `npm i -g @openai/codex` installs a `codex.cmd`/`codex.ps1` shim,
// which Node's spawn() refuses to run without shell:true (EINVAL since the
// CVE-2024-27980 fix). We must NOT use shell:true (prompts are arbitrary text),
// so we resolve the real `codex.exe` binary instead.
//
// Resolution order (see resolveCodexBinary):
//   1. env CODEX_BIN (validated: must point to an existing file).
//   2. win32: the vendored codex.exe under the npm global install, i.e.
//        <npm node_modules>\@openai\codex\node_modules\@openai\codex-win32-*\
//          vendor\*\bin\codex.exe
//      searched under %APPDATA%\npm\node_modules and under the node_modules
//      sibling of any PATH dir that contains a codex.cmd shim.
//   3. fallback: "codex.exe" on win32, "codex" elsewhere (a bare name resolved
//      via PATH); if that cannot be spawned, ENOENT yields a clear error.

const defaultIo = {
  exists: (p) => fs.existsSync(p),
  readdir: (p) => fs.readdirSync(p),
};

// Candidate `node_modules` directories to search for the vendored codex.exe on
// Windows: the npm global modules dir, plus the node_modules sibling of any PATH
// entry that holds a codex.cmd shim.
export function windowsModuleDirs(env, io = defaultIo) {
  const dirs = [];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, "npm", "node_modules"));
  const pathEntries = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    if (io.exists(path.join(dir, "codex.cmd"))) {
      dirs.push(path.join(dir, "node_modules"));
    }
  }
  return dirs;
}

// Given candidate node_modules dirs, locate the first existing vendored
// codex.exe. Pure/injectable so it can be unit-tested without real Windows.
export function locateWindowsCodexExe(moduleDirs, io = defaultIo) {
  for (const base of moduleDirs) {
    const openaiDir = path.join(base, "@openai", "codex", "node_modules", "@openai");
    let platforms;
    try {
      platforms = io.readdir(openaiDir);
    } catch {
      continue;
    }
    for (const plat of platforms) {
      if (!/^codex-win32-/.test(plat)) continue;
      const vendorDir = path.join(openaiDir, plat, "vendor");
      let targets;
      try {
        targets = io.readdir(vendorDir);
      } catch {
        continue;
      }
      for (const target of targets) {
        const exe = path.join(vendorDir, target, "bin", "codex.exe");
        if (io.exists(exe)) return exe;
      }
    }
  }
  return null;
}

// Uncached resolution. Throws ValidationError if CODEX_BIN is set but missing.
export function computeCodexBinary(env = process.env, platform = process.platform, io = defaultIo) {
  const override = env.CODEX_BIN;
  if (override && override.trim()) {
    const p = override.trim();
    if (!io.exists(p)) {
      throw new ValidationError(
        `CODEX_BIN is set to "${p}" but no file exists there. ` +
          `Point CODEX_BIN at the absolute path of the codex binary (codex.exe on Windows).`
      );
    }
    return p;
  }
  if (platform === "win32") {
    const found = locateWindowsCodexExe(windowsModuleDirs(env, io), io);
    if (found) return found;
    return "codex.exe"; // last resort; spawn ENOENT will produce a clear error
  }
  return "codex";
}

let _cachedBin;
// Resolve the codex binary once and cache it. Every spawn site uses this.
export function resolveCodexBinary() {
  if (_cachedBin !== undefined) return _cachedBin;
  _cachedBin = computeCodexBinary();
  return _cachedBin;
}

// For tests only: clear the cached resolution.
export function _resetCodexBinaryCache() {
  _cachedBin = undefined;
}

// Root directory for persisted job state. Overridable via CODEX_BROKER_HOME.
export function brokerHome() {
  const override = process.env.CODEX_BROKER_HOME;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".codex-broker");
}

export function jobsDir() {
  // CODEX_BROKER_JOBS_DIR relocates the jobs dir wholesale (useful under
  // Windows MSIX virtualization where the default home path may be redirected).
  const override = process.env.CODEX_BROKER_JOBS_DIR;
  if (override && override.trim()) return override.trim();
  return path.join(brokerHome(), "jobs");
}

export class ValidationError extends Error {}

// Build a helpful message when a codex process fails to spawn, naming the
// resolved binary and giving OS-specific guidance. Shared by the direct sync
// spawn path and the background runner.
export function spawnFailureMessage(bin, err) {
  const code = err && err.code ? ` (${err.code})` : "";
  let msg = `failed to start codex binary "${bin}"${code}: ${err && err.message ? err.message : err}.`;
  if (err && err.code === "ENOENT") {
    msg +=
      ` The codex binary could not be found. Install it (npm i -g @openai/codex) and/or set` +
      ` the CODEX_BIN environment variable to the absolute path of the real codex binary` +
      ` (codex.exe on Windows — NOT the codex.cmd shim).`;
  } else if (err && err.code === "EINVAL") {
    msg +=
      ` On Windows this usually means codex resolved to a .cmd/.ps1 shim, which cannot be` +
      ` spawned without a shell. Set CODEX_BIN to the vendored codex.exe path shown by` +
      ` \`codex doctor\`.`;
  }
  return msg;
}

export function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`Missing or empty required parameter "${name}".`);
  }
  return value;
}

export function validateSandbox(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_SANDBOX;
  if (!ALLOWED_SANDBOXES.includes(value)) {
    throw new ValidationError(
      `Invalid sandbox "${value}". Allowed values: ${ALLOWED_SANDBOXES.join(", ")}. ` +
        `(danger-full-access is intentionally not supported by this broker.)`
    );
  }
  return value;
}

// cwd must be an absolute path to an existing directory.
export function validateCwd(value) {
  requireString(value, "cwd");
  if (!path.isAbsolute(value)) {
    throw new ValidationError(`cwd must be an absolute path, got "${value}".`);
  }
  let st;
  try {
    st = fs.statSync(value);
  } catch {
    throw new ValidationError(`cwd does not exist: "${value}".`);
  }
  if (!st.isDirectory()) {
    throw new ValidationError(`cwd is not a directory: "${value}".`);
  }
  return value;
}

// Model precedence: explicit param > CODEX_MODEL env > null (codex default).
export function resolveModel(param) {
  if (typeof param === "string" && param.trim() !== "") return param.trim();
  const env = process.env.CODEX_MODEL;
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  return null;
}

export function clampTimeoutSeconds(value, def) {
  if (value === undefined || value === null) return def;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`timeout_seconds must be a positive number, got "${value}".`);
  }
  return Math.floor(n);
}

// Truncate long text and add a clear notice, keeping the tail (most recent /
// most relevant output usually lives at the end).
export function truncate(text, max = MAX_OUTPUT_CHARS) {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= max) return s;
  const kept = s.slice(s.length - max);
  const dropped = s.length - max;
  return `[... ${dropped} chars truncated ...]\n${kept}`;
}

export function lastLines(text, n = 20) {
  const lines = String(text ?? "").split(/\r?\n/);
  // Drop a trailing empty line from a final newline.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

// ---- Plain binary resolvers (unsandboxed broker-side git/gh) ---------------
import { spawnSync as _spawnSyncForResolve } from "node:child_process";
import _fsResolve from "node:fs";
import _pathResolve from "node:path";

let cachedGit = null;
export function resolveGitBinary(env = process.env) {
  if (cachedGit) return cachedGit;
  if (env.GIT_BIN) {
    if (!_fsResolve.existsSync(env.GIT_BIN)) throw new ValidationError(`GIT_BIN is set but does not exist: ${env.GIT_BIN}`);
    return (cachedGit = env.GIT_BIN);
  }
  if (process.platform === "win32") {
    for (const p of [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    ]) {
      if (_fsResolve.existsSync(p)) return (cachedGit = p);
    }
    return (cachedGit = "git.exe");
  }
  return (cachedGit = "git");
}

let cachedGh = null;
export function resolveGhBinary(env = process.env) {
  if (cachedGh) return cachedGh;
  if (env.GH_BIN) {
    if (!_fsResolve.existsSync(env.GH_BIN)) throw new ValidationError(`GH_BIN is set but does not exist: ${env.GH_BIN}`);
    return (cachedGh = env.GH_BIN);
  }
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA;
    const candidates = [];
    if (local) {
      const wingetDir = _pathResolve.join(local, "Microsoft", "WinGet", "Packages");
      try {
        for (const d of _fsResolve.readdirSync(wingetDir)) {
          if (/^GitHub\.cli_/i.test(d)) candidates.push(_pathResolve.join(wingetDir, d, "bin", "gh.exe"));
        }
      } catch { /* ignore */ }
      candidates.push(_pathResolve.join(local, "Programs", "GitHub CLI", "gh.exe"));
    }
    candidates.push("C:\\Program Files\\GitHub CLI\\gh.exe");
    for (const p of candidates) {
      if (_fsResolve.existsSync(p)) return (cachedGh = p);
    }
    return (cachedGh = "gh.exe");
  }
  return (cachedGh = "gh");
}

// Repo name validation for gh_repo_create: conservative GitHub repo charset.
export function validateRepoName(name) {
  const v = requireString(name, "name");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(v)) {
    throw new ValidationError(`Invalid repo name "${v}" (letters, digits, ., _, - only).`);
  }
  return v;
}

// Branch/remote validation for git_push: refuse anything that could be a flag.
export function validateRefName(value, label, fallback) {
  const v = value == null || value === "" ? fallback : value;
  if (typeof v !== "string" || !v || v.startsWith("-") || /[\s~^:?*\[\]\\]/.test(v)) {
    throw new ValidationError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return v;
}
