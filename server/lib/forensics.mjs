// Job forensics: turn a job directory into the evidence an escalation needs
// (skill/SKILL.md → "Escalating to Fable"). Buckets connection errors in
// output.log by minute; on Windows pulls the host's power (Modern Standby
// 506/507) and WLAN (8001/8003) events for the job's window and correlates
// them. docs/LESSONS.md #9 is the case this was built from: every 11001 burst
// sat within seconds of a wake.
//
// The broker calls summary() automatically for failed or stalled jobs whose
// log shows connection errors (codex_status / codex_result), so nobody has to
// remember a script. scripts/job-forensics.mjs is the CLI over the same code
// for jobs from earlier sessions.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ERROR_LINE = /os error 11001|No such host|Reconnecting\.\.\.|Falling back from WebSockets|stream disconnected|idle timeout waiting|failed to refresh available models|turn\.failed/;
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;

export function hasConnectionErrors(logText) {
  return ERROR_LINE.test(String(logText ?? ""));
}

// Explicit homes restrict the search; otherwise every known home is tried
// (env overrides first, then the default and the CLI-registration
// convention), because the job you are looking for is often under the one
// you did not expect (docs/LESSONS.md #9).
export function candidateJobDirs(homes = [], env = process.env) {
  const dirs = [];
  if (homes.length) {
    for (const h of homes) dirs.push(path.join(h, "jobs"));
  } else {
    if (env.CODEX_BROKER_JOBS_DIR) dirs.push(env.CODEX_BROKER_JOBS_DIR);
    for (const h of [env.CODEX_BROKER_HOME, path.join(os.homedir(), ".codex-broker"), path.join(os.homedir(), ".codex-broker-cli")]) {
      if (h) dirs.push(path.join(h, "jobs"));
    }
  }
  return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}

export function findJob(opts, env = process.env) {
  const hits = [];
  for (const jobs of candidateJobDirs(opts.homes, env)) {
    for (const name of fs.readdirSync(jobs)) {
      if (!fs.existsSync(path.join(jobs, name, "meta.json"))) continue;
      if (opts.latest || name === opts.id || name.endsWith(opts.id)) hits.push(path.join(jobs, name));
    }
  }
  if (opts.latest) return hits.sort((a, b) => path.basename(b).localeCompare(path.basename(a)))[0] || null;
  if (hits.length > 1) throw new Error(`ambiguous job id, matches:\n  ${hits.join("\n  ")}`);
  return hits[0] || null;
}

// Error lines bucketed by UTC minute. JSON "Reconnecting" events carry no
// timestamp; they are attributed to the most recent timestamped line.
export function errorBuckets(logText) {
  const buckets = new Map();
  let lastStamp = null;
  for (const line of String(logText ?? "").split(/\r?\n/)) {
    const m = line.match(STAMP);
    if (m) lastStamp = m[1];
    if (!ERROR_LINE.test(line)) continue;
    const key = (m ? m[1] : lastStamp || "unstamped").slice(0, 16);
    const b = buckets.get(key) || { minute: key, count: 0, sample: line.slice(0, 160) };
    b.count++;
    buckets.set(key, b);
  }
  return [...buckets.values()];
}

// Windows only: Modern Standby enter/exit and WLAN connect/disconnect events
// in [start, end], as { t: ISO, ms, id, src, msg }.
export function windowsEvents(startIso, endIso) {
  if (process.platform !== "win32") return { supported: false, events: [] };
  const ps = `
$s=[datetime]::Parse('${startIso}').ToLocalTime(); $e=[datetime]::Parse('${endIso}').ToLocalTime();
$out=@()
try { $out += Get-WinEvent -ErrorAction Stop -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-Power';Id=506,507;StartTime=$s;EndTime=$e} | ForEach-Object { $r=($_.Message -split "\`n" | Where-Object { $_ -match 'Reason' }) -join ' '; [pscustomobject]@{t=$_.TimeCreated.ToUniversalTime().ToString('o');id=$_.Id;src='power';msg=(($_.Message -split "\`n")[0].Trim()+' '+$r).Trim()} } } catch {}
try { $out += Get-WinEvent -ErrorAction Stop -FilterHashtable @{LogName='Microsoft-Windows-WLAN-AutoConfig/Operational';Id=8001,8003;StartTime=$s;EndTime=$e} | ForEach-Object { $r=($_.Message -split "\`n" | Where-Object { $_ -match 'Reason' }) -join ' '; [pscustomobject]@{t=$_.TimeCreated.ToUniversalTime().ToString('o');id=$_.Id;src='wlan';msg=(($_.Message -split "\`n")[0].Trim()+' '+$r).Trim()} } } catch {}
ConvertTo-Json -Compress @($out)`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 45000, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return { supported: true, events: [], error: (r.stderr || "").trim().slice(0, 300) };
  try {
    const arr = JSON.parse(r.stdout);
    return { supported: true, events: (Array.isArray(arr) ? arr : [arr]).map((e) => ({ ...e, ms: Date.parse(e.t) })).sort((a, b) => a.ms - b.ms) };
  } catch (e) {
    return { supported: true, events: [], error: `could not parse event JSON: ${e.message}` };
  }
}

// For each error minute, the nearest host event and its distance. A burst is
// "explained" when a power/WLAN event lies within windowSeconds of the minute.
export function correlate(buckets, events, windowSeconds = 120) {
  const rows = buckets.map((b) => {
    if (b.minute === "unstamped") return { ...b, nearest: null, deltaSeconds: null, explained: false };
    const start = Date.parse(b.minute + ":00Z");
    const end = start + 60000;
    let best = null;
    for (const e of events) {
      const d = e.ms < start ? (start - e.ms) / 1000 : e.ms > end ? (e.ms - end) / 1000 : 0;
      if (!best || d < best.d) best = { e, d };
    }
    return { ...b, nearest: best ? best.e : null, deltaSeconds: best ? Math.round(best.d) : null, explained: !!best && best.d <= windowSeconds };
  });
  const stamped = rows.filter((r) => r.minute !== "unstamped");
  const explained = stamped.filter((r) => r.explained).length;
  let verdict;
  if (stamped.length === 0) verdict = "no timestamped connection errors in this log";
  else if (events.length === 0) verdict = "no host power/WLAN events available for the window — correlation not possible; do not conclude a network fault without another evidence source";
  else if (explained * 2 >= stamped.length) verdict = `HOST: ${explained}/${stamped.length} error bursts sit within ${windowSeconds}s of a sleep/Wi-Fi event — the machine slept or the link dropped; this is not DNS or the Codex transport`;
  else verdict = `UNEXPLAINED: only ${explained}/${stamped.length} bursts coincide with host events — investigate the network path (and check the machine's clock)`;
  return { rows, verdict, explained, total: stamped.length };
}

function readJsonSafe(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

// Everything the renderers need, computed once.
export function analyze(jobDir, opts = {}) {
  const events = opts.events !== false;
  const windowSeconds = opts.windowSeconds || 120;
  const meta = readJsonSafe(path.join(jobDir, "meta.json")) || {};
  const exitFile = path.join(jobDir, "exit");
  const exit = fs.existsSync(exitFile) ? fs.readFileSync(exitFile, "utf8").trim() : "(none — orphaned or still running)";
  const logPath = path.join(jobDir, "output.log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const lines = log.split(/\r?\n/).filter(Boolean);
  const stamps = lines.map((l) => (l.match(STAMP) || [])[1]).filter(Boolean);
  const startIso = meta.createdAt || (stamps[0] ? stamps[0] + "Z" : null);
  let endIso = meta.endedAt || null;
  if (!endIso && exit.startsWith("(")) endIso = new Date().toISOString(); // still running: window to now
  if (!endIso && stamps.length) endIso = stamps[stamps.length - 1] + "Z";
  if (!endIso && fs.existsSync(logPath)) endIso = fs.statSync(logPath).mtime.toISOString();

  const buckets = errorBuckets(log);
  let ev = { supported: false, events: [] };
  if (events && startIso && endIso && buckets.length) {
    const pad = 5 * 60000;
    ev = windowsEvents(new Date(Date.parse(startIso) - pad).toISOString(), new Date(Date.parse(endIso) + pad).toISOString());
  }
  const correlation = correlate(buckets, ev.events, windowSeconds);
  return { jobDir, logPath, meta, exit, lines, startIso, endIso, buckets, ev, correlation, windowSeconds };
}

function shortMinute(minute) {
  return minute === "unstamped" ? minute : `${minute.slice(11)}Z`;
}

// Compact block the broker appends to codex_status / codex_result.
export function summary(jobDir, opts = {}) {
  const a = analyze(jobDir, opts);
  const out = [`Forensics (auto; docs/LESSONS.md #9):`];
  out.push(`  connection errors by UTC minute: ${a.buckets.map((b) => `${shortMinute(b.minute)} x${b.count}`).join(", ") || "(none)"}`);
  if (!a.ev.supported) out.push(`  host events: not available on ${process.platform} (Windows only)`);
  else if (a.ev.error) out.push(`  host events: query failed — ${a.ev.error}`);
  else out.push(`  host events in window: ${a.ev.events.length} (power 506/507, wlan 8001/8003)`);
  for (const r of a.correlation.rows) {
    if (r.minute === "unstamped") continue;
    out.push(
      `  ${shortMinute(r.minute)} x${r.count}  ${r.nearest ? `${r.explained ? "EXPLAINED" : "unexplained"}  ${r.nearest.src}:${r.nearest.id} ${r.nearest.msg.slice(0, 60)} (${r.deltaSeconds}s)` : "no host events"}`
    );
  }
  out.push(`  VERDICT: ${a.correlation.verdict}`);
  out.push(`  log: ${a.logPath}`);
  out.push(`  full report: node scripts/job-forensics.mjs ${path.basename(jobDir)}`);
  return out.join("\n");
}

// Full report for the CLI.
export function report(jobDir, opts = {}) {
  const a = analyze(jobDir, opts);
  const out = [];
  out.push(`# Job forensics: ${path.basename(jobDir)}`);
  out.push(`job dir:   ${jobDir}`);
  out.push(`log:       ${a.logPath}`);
  out.push(`class/mode: ${a.meta.jobClass || "?"} / ${a.meta.mode || "?"}    cwd: ${a.meta.cwd || "?"}`);
  out.push(`created:   ${a.startIso || "?"}    ended: ${a.meta.endedAt || "(not recorded)"}    exit: ${a.exit}`);
  if (a.meta.stalled) out.push(`stalled:   killed by the broker after ${a.meta.stalledAfterSeconds}s without output (max_idle_seconds=${a.meta.maxIdleSeconds})`);
  if (a.startIso && a.endIso) out.push(`window:    ${a.startIso} → ${a.endIso}  (${Math.round((Date.parse(a.endIso) - Date.parse(a.startIso)) / 60000)} min)`);
  out.push("");
  out.push(`## Connection errors by UTC minute (${a.buckets.reduce((n, b) => n + b.count, 0)} lines)`);
  if (a.buckets.length === 0) out.push("(none)");
  for (const b of a.buckets) out.push(`${b.minute}Z  x${String(b.count).padStart(3)}  ${b.sample}`);
  out.push("");
  out.push(`## Host power / Wi-Fi events in window${a.ev.supported ? "" : " (Windows only; skipped)"}${a.ev.error ? ` — error: ${a.ev.error}` : ""}`);
  for (const e of a.ev.events) out.push(`${new Date(e.ms).toISOString()}  ${e.src}:${e.id}  ${e.msg.slice(0, 110)}`);
  if (a.ev.supported && a.ev.events.length === 0 && !a.ev.error) out.push("(none)");
  out.push("");
  out.push(`## Correlation (window ±${a.windowSeconds}s)`);
  for (const r of a.correlation.rows) {
    if (r.minute === "unstamped") continue;
    out.push(`${r.minute}Z  x${String(r.count).padStart(3)}  ${r.nearest ? `${r.explained ? "EXPLAINED" : "unexplained"}  nearest ${r.nearest.src}:${r.nearest.id} at ${new Date(r.nearest.ms).toISOString()} (${r.deltaSeconds}s)` : "no host events"}`);
  }
  out.push(`VERDICT: ${a.correlation.verdict}`);
  out.push("");
  out.push("## Last 10 log lines");
  for (const l of a.lines.slice(-10)) out.push(l.slice(0, 220));
  return out.join("\n");
}
