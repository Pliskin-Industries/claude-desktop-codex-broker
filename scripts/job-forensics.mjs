#!/usr/bin/env node
// CLI over server/lib/forensics.mjs — the same analysis the broker appends
// automatically to codex_status / codex_result for failed or stalled jobs.
// Use it for jobs from earlier sessions or when you want the full report.
//
//   node scripts/job-forensics.mjs <job_id | unique suffix | --latest>
//        [--home <broker-home>] [--no-events] [--window-seconds 120]
//
// Prints a report you can paste verbatim into an escalation. Exit 0 always.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { candidateJobDirs, findJob, report } from "../server/lib/forensics.mjs";

export function parseArgs(argv) {
  const o = { id: null, latest: false, homes: [], events: true, windowSeconds: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--latest") o.latest = true;
    else if (a === "--home") o.homes.push(argv[++i]);
    else if (a === "--no-events") o.events = false;
    else if (a === "--window-seconds") o.windowSeconds = Number(argv[++i]) || 120;
    else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else o.id = a;
  }
  if (!o.id && !o.latest) throw new Error("usage: job-forensics.mjs <job_id|suffix|--latest> [--home DIR] [--no-events]");
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = findJob(opts);
  if (!dir) {
    console.log(`no job matching "${opts.id ?? "--latest"}" under: ${candidateJobDirs(opts.homes).join(", ") || "(no broker homes found)"}`);
    return;
  }
  console.log(report(dir, opts));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`job-forensics: ${e.message}`);
    process.exit(2);
  }
}
