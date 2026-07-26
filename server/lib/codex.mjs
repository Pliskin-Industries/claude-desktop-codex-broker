// Builds codex CLI argument arrays and parses codex output (JSONL + the
// --output-last-message file) to extract the final assistant message and the
// session/thread id. All arg arrays are built as arrays (never shell strings);
// the prompt is always fed via stdin using the "-" sentinel so arbitrary
// prompt text can never be interpreted as flags.
import fs from "node:fs";

// Flags this broker will NEVER pass, regardless of input.
export const FORBIDDEN_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
];

function assertSafe(argv) {
  for (const a of argv) {
    if (FORBIDDEN_FLAGS.includes(a) || a === "danger-full-access") {
      throw new Error(`Refusing to build a codex command containing forbidden flag/value: ${a}`);
    }
  }
  return argv;
}

// codex exec --json ... -o <lastMessageFile> [-m model] -s <sandbox> -
export function buildTaskArgs({ sandbox, model, lastMessageFile, network }) {
  const argv = ["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "-o", lastMessageFile];
  // Opt-in network for git push/pull etc. Only meaningful with workspace-write;
  // filesystem sandboxing is unchanged. Never combined with danger flags.
  if (network && sandbox === "workspace-write") argv.push("-c", "sandbox_workspace_write.network_access=true");
  if (model) argv.push("-m", model);
  argv.push("-"); // prompt from stdin
  return assertSafe(argv);
}

// codex exec resume --json ... -o <file> [-m model] <session_id> -
// NOTE: resume has no -s/--sandbox flag; it inherits the original session's
// sandbox. It also has no --cd; cwd is set via the spawn option.
export function buildResumeArgs({ sessionId, model, lastMessageFile }) {
  const argv = ["exec", "resume", "--json", "--skip-git-repo-check", "-o", lastMessageFile];
  if (model) argv.push("-m", model);
  argv.push(sessionId, "-"); // session id positional, then prompt from stdin
  return assertSafe(argv);
}

// codex exec review --json ... -o <file> [-m model] [-]
// review is inherently read-only (no -s flag). Focus text, when present, is
// passed as the custom review instruction via stdin ("-").
export function buildReviewArgs({ model, hasFocus, lastMessageFile }) {
  const argv = ["exec", "review", "--json", "--skip-git-repo-check", "-o", lastMessageFile];
  if (model) argv.push("-m", model);
  if (hasFocus) argv.push("-");
  return assertSafe(argv);
}

// Extract the session/thread id from a JSON event object, checking the several
// shapes codex has emitted across versions.
function sessionIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  return (
    obj.thread_id ||
    obj.session_id ||
    obj.threadId ||
    obj.sessionId ||
    (obj.thread && (obj.thread.id || obj.thread.thread_id)) ||
    (obj.params && obj.params.thread && obj.params.thread.id) ||
    (obj.params && (obj.params.threadId || obj.params.sessionId)) ||
    (obj.msg && (obj.msg.session_id || obj.msg.thread_id)) ||
    null
  );
}

// Extract an assistant/agent message text from a JSON event object.
function agentMessageFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  // exec --json (new): { type:"item.completed", item:{ type:"agent_message", text:"..." } }
  const item = obj.item || (obj.params && obj.params.item);
  if (item && (item.type === "agent_message" || item.type === "assistant_message")) {
    if (typeof item.text === "string") return item.text;
    if (typeof item.message === "string") return item.message;
  }
  // older: { msg:{ type:"agent_message", message:"..." } }
  if (obj.msg && obj.msg.type === "agent_message" && typeof obj.msg.message === "string") {
    return obj.msg.message;
  }
  return null;
}

// Parse the whole output.log (JSONL, possibly with non-JSON noise) to find the
// session id and the last agent message seen.
export function parseLog(logText) {
  let sessionId = null;
  let lastAgentMessage = null;
  const lines = String(logText ?? "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed);
        const sid = sessionIdFromObject(obj);
        if (sid && !sessionId) sessionId = String(sid);
        const msg = agentMessageFromObject(obj);
        if (msg != null) lastAgentMessage = msg;
        continue;
      } catch {
        // fall through to regex handling
      }
    }
    // Text fallback: lines like "session id: <uuid>" or "thread id: <id>".
    const m = trimmed.match(/(?:session|thread)[ _]?id[:=]?\s*([0-9A-Za-z][0-9A-Za-z_-]{6,})/i);
    if (m && !sessionId) sessionId = m[1];
  }
  return { sessionId, lastAgentMessage };
}

// Compute final message + session id for a job directory, preferring the
// -o last-message file for the final text and falling back to the parsed log.
export function extractResult({ logText, lastMessageFile }) {
  let finalMessage = "";
  try {
    if (lastMessageFile && fs.existsSync(lastMessageFile)) {
      finalMessage = fs.readFileSync(lastMessageFile, "utf8").trim();
    }
  } catch {
    /* ignore */
  }
  const { sessionId, lastAgentMessage } = parseLog(logText);
  if (!finalMessage && lastAgentMessage) finalMessage = String(lastAgentMessage).trim();
  return { finalMessage, sessionId };
}
