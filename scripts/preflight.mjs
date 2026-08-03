#!/usr/bin/env node
// Read-only preflight for running the broker in a cloud / headless container.
//
// Checks the things that actually stop Codex delegation from working, and — the
// part that matters — explains WHICH kind of failure occurred. In a hosted
// container the usual failure is an egress policy denial, which surfaces as an
// opaque proxy error that reads like a broker bug. It isn't one, and no amount
// of retrying will fix it.
//
// Exits 0 if delegation should work, 1 if something blocking was found.
// Usage: node scripts/preflight.mjs [--json]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROBE_URL = "https://api.openai.com/v1/models";
const MIN_NODE = [18, 18];

// --- Pure classifier (exported for tests) ----------------------------------

// Map a probe's outcome onto a category plus advice. Kept pure and free of I/O
// so the interesting branches can be tested without a network.
//
// httpCode is curl's %{http_code} ("000" when the connection never completed);
// stderr is curl's diagnostic text.
export function classifyProbeFailure({ httpCode, stderr }) {
  const code = String(httpCode || "").trim();
  const err = String(stderr || "");

  // 401/403 *from the API itself* still proves reachability. Distinguish that
  // from a 403 on the proxy's CONNECT, which means we never got out at all.
  const proxyDenied = /CONNECT tunnel failed[^]*?\b(403|407)\b|\b(403|407)\b[^]*?CONNECT/i.test(err);

  if (!proxyDenied && (code === "200" || code === "401")) {
    return {
      ok: true,
      category: "reachable",
      summary: code === "401" ? "reachable (credentials not accepted, but egress works)" : "reachable",
      advice: null,
    };
  }

  if (proxyDenied || code === "403" || code === "407") {
    return {
      ok: false,
      category: "policy",
      summary: "blocked by egress policy",
      advice:
        `The proxy refused to open a tunnel to api.openai.com (HTTP 403/407). This is an\n` +
        `  organization egress policy decision, not a misconfiguration — retrying and routing\n` +
        `  around it are both the wrong move.\n` +
        `  Fix: allowlist api.openai.com in the environment's network policy, then re-run.`,
    };
  }

  if (/certificate verify failed|self.signed certificate|unable to get local issuer/i.test(err)) {
    return {
      ok: false,
      category: "tls",
      summary: "TLS verification failed",
      advice:
        `The proxy re-terminates TLS and this client is not trusting its CA.\n` +
        `  Fix: point NODE_EXTRA_CA_CERTS (and SSL_CERT_FILE for non-Node tools) at the\n` +
        `  environment's CA bundle. Never disable verification.`,
    };
  }

  if (/405|Method Not Allowed/i.test(err)) {
    return {
      ok: false,
      category: "proxy-method",
      summary: "proxy rejected a plain-HTTP request",
      advice:
        `The client sent a non-CONNECT request. Usually HTTP_PROXY is set when only\n` +
        `  HTTPS_PROXY is supported.\n` +
        `  Fix: unset HTTP_PROXY for this tool.`,
    };
  }

  if (/timed out|Connection refused|Could not resolve|Resolving timed out/i.test(err)) {
    return {
      ok: false,
      category: "unreachable",
      summary: "no route to api.openai.com",
      advice:
        `The connection never completed and the proxy reported nothing.\n` +
        `  Fix: confirm HTTPS_PROXY is set and that this client honors it.`,
    };
  }

  return {
    ok: false,
    category: "unknown",
    summary: `unrecognized failure (http_code=${code || "none"})`,
    advice: err ? `  Raw client output:\n  ${err.trim().split("\n").slice(0, 4).join("\n  ")}` : null,
  };
}

export function parseNodeVersion(v) {
  const m = String(v || "").match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function meetsMinimum(actual, minimum) {
  if (!actual) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

// --- Checks ----------------------------------------------------------------

function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? [bin] : ["-v", bin],
    { encoding: "utf8", shell: process.platform !== "win32" });
  return r.status === 0 ? String(r.stdout).trim().split("\n")[0] : null;
}

function probeEgress() {
  const curl = which("curl");
  if (!curl) {
    return { ok: false, category: "no-curl", summary: "curl not available to probe egress", advice: null };
  }
  const r = spawnSync(
    "curl",
    ["-sS", "--max-time", "25", "-o", "/dev/null", "-w", "%{http_code}", PROBE_URL],
    { encoding: "utf8" }
  );
  return classifyProbeFailure({ httpCode: r.stdout, stderr: r.stderr });
}

function run() {
  const results = [];
  const add = (name, ok, detail, advice = null) => results.push({ name, ok, detail, advice });

  // Node
  const nodeV = parseNodeVersion(process.version);
  add("node", meetsMinimum(nodeV, MIN_NODE), `${process.version} (need >= ${MIN_NODE.join(".")})`);

  // Server dependencies
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const hasDeps = fs.existsSync(path.join(repoRoot, "server", "node_modules"));
  add("server deps", hasDeps, hasDeps ? "installed" : "missing",
    hasDeps ? null : "  Fix: npm ci --prefix server");

  // Codex CLI
  const codexBin = process.env.CODEX_BIN || which("codex");
  let codexVer = null;
  if (codexBin) {
    const r = spawnSync(codexBin, ["--version"], { encoding: "utf8" });
    codexVer = r.status === 0 ? String(r.stdout).trim() : null;
  }
  add("codex cli", Boolean(codexVer), codexVer || (codexBin ? `found at ${codexBin} but --version failed` : "not found"),
    codexVer ? null : "  Fix: npm install -g @openai/codex");

  // Auth — report only WHICH method is configured, never a secret value.
  let authDetail = "not logged in";
  let authOk = false;
  if (codexBin) {
    const r = spawnSync(codexBin, ["login", "status"], { encoding: "utf8" });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    authOk = r.status === 0 && !/not logged in/i.test(out);
    if (authOk) authDetail = "logged in";
  }
  const haveSecret = Boolean(process.env.CODEX_ACCESS_TOKEN || process.env.OPENAI_API_KEY);
  if (!authOk && haveSecret) {
    authDetail = `not logged in, but ${process.env.CODEX_ACCESS_TOKEN ? "CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY"} is set`;
  }
  add("codex auth", authOk, authDetail,
    authOk ? null
      : haveSecret
        ? "  Fix: run scripts/cloud-setup.sh to authenticate from the environment secret."
        : "  Fix: set OPENAI_API_KEY (API billing) or CODEX_ACCESS_TOKEN (ChatGPT plan)\n" +
          "  as an environment secret, then run scripts/cloud-setup.sh.");

  // Sandbox backend
  const bwrap = which("bubblewrap") || which("bwrap");
  add("sandbox", true,
    bwrap ? `bubblewrap at ${bwrap}` : "bubblewrap not on PATH — Codex will use its bundled copy (fine)");

  // Egress — the one that usually decides everything
  const egress = probeEgress();
  add("egress", egress.ok, `api.openai.com — ${egress.summary}`, egress.advice);

  return results;
}

// Only probe and exit when run as a script. The pure helpers above are imported
// by the test suite, which must not inherit a process.exit() or a network probe.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const results = run();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  } else {
    console.log("codex-broker preflight\n");
    for (const r of results) {
      console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(12)} ${r.detail}`);
      if (!r.ok && r.advice) console.log(`\n${r.advice}\n`);
    }
    const blocking = results.filter((r) => !r.ok);
    console.log("");
    console.log(blocking.length === 0
      ? "All checks passed — Codex delegation should work."
      : `${blocking.length} blocking issue(s): ${blocking.map((r) => r.name).join(", ")}`);
  }

  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
