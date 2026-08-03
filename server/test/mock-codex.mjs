#!/usr/bin/env node
// Mock of the `codex` CLI, emulating exactly the `codex exec` / `codex exec
// resume` / `codex exec review` interface the broker relies on. Placed first on
// PATH (as `codex`) by the test harness so the broker drives this instead of
// the real binary (which can't reach OpenAI from the test environment).
//
// Behaviour is driven by tokens in the prompt (read from stdin via the "-"
// sentinel the broker passes):
//   SLEEP=<n>  sleep n seconds before finishing (simulates a long run)
//   FAIL       exit non-zero after emitting an error (simulates a failed job)
//
// Emits JSONL events on stdout (thread.started / item.completed /
// turn.completed) and writes the final assistant message to the
// --output-last-message file, including a session/thread id the broker parses.
import fs from "node:fs";
import crypto from "node:crypto";

const args = process.argv.slice(2);

let mode = "exec";
let i = 1; // args[0] is "exec"
if (args[1] === "resume") {
  mode = "resume";
  i = 2;
} else if (args[1] === "review") {
  mode = "review";
  i = 2;
}

let outFile = null;
let sandbox = null;
let model = null;
let promptFromStdin = false;
const positionals = [];

for (; i < args.length; i++) {
  const a = args[i];
  if (a === "--json" || a === "--skip-git-repo-check" || a === "--all" || a === "--last" || a === "--uncommitted" || a === "--ephemeral" || a === "--ignore-user-config" || a === "--ignore-rules" || a === "--strict-config") {
    continue;
  } else if (a === "-s" || a === "--sandbox") {
    sandbox = args[++i];
  } else if (a === "-m" || a === "--model") {
    model = args[++i];
  } else if (a === "-o" || a === "--output-last-message") {
    outFile = args[++i];
  } else if (a === "-c" || a === "--config" || a === "-C" || a === "--cd" || a === "--add-dir" || a === "--base" || a === "--commit" || a === "--title" || a === "-p" || a === "--profile" || a === "-i" || a === "--image" || a === "--output-schema" || a === "--color" || a === "--enable" || a === "--disable" || a === "--local-provider") {
    i++; // skip the value
  } else if (a === "-") {
    promptFromStdin = true;
    positionals.push("-");
  } else {
    positionals.push(a);
  }
}

// Reject flags the broker promises never to pass (guards the safety contract).
if (args.includes("--dangerously-bypass-approvals-and-sandbox") || sandbox === "danger-full-access") {
  process.stderr.write("mock-codex: refusing dangerous flag\n");
  process.exit(3);
}

let sessionId;
if (mode === "resume") {
  // resume args: [session_id, "-"]; first non-"-" positional is the id.
  sessionId = positionals.find((p) => p !== "-") || "unknown-session";
} else {
  sessionId = `sess-${crypto.randomBytes(6).toString("hex")}`;
}

let prompt = "";
if (promptFromStdin) {
  try {
    prompt = fs.readFileSync(0, "utf8");
  } catch {
    prompt = "";
  }
}

const sleepMatch = prompt.match(/SLEEP=(\d+)/);
const sleepSeconds = sleepMatch ? parseInt(sleepMatch[1], 10) : 0;
const shouldFail = /\bFAIL\b/.test(prompt);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Emit the session/thread id immediately so status polls can surface it while
// the job is still running.
emit({ type: "thread.started", thread_id: sessionId });
emit({ type: "turn.started" });

function finish() {
  if (shouldFail) {
    emit({ type: "error", message: "mock-codex simulated failure" });
    process.stderr.write("codex error: simulated failure\n");
    process.exit(1);
  }

  let finalMessage;
  if (mode === "review") {
    const focus = prompt.trim();
    finalMessage =
      `Code review complete (mock).\n` +
      (focus ? `Focus: ${focus}\n` : "") +
      `Findings: 1 minor issue found in example.js (mock finding).`;
  } else if (mode === "resume") {
    finalMessage = `Resumed session ${sessionId} (mock). Handled follow-up: ${prompt.trim().slice(0, 80)}`;
  } else {
    finalMessage = `Task complete (mock). Model=${model || "default"} sandbox=${sandbox || "n/a"}. Prompt was: ${prompt.trim().slice(0, 80)}`;
  }

  emit({ type: "item.completed", item: { type: "agent_message", text: finalMessage } });
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20 } });

  if (outFile) {
    try {
      fs.writeFileSync(outFile, finalMessage);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

if (sleepSeconds > 0) {
  setTimeout(finish, sleepSeconds * 1000);
} else {
  finish();
}
