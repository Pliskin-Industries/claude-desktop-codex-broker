import path from "node:path";
import { fileURLToPath } from "node:url";

const executable = path.basename(process.execPath).toLowerCase();

if (executable === "codex.exe") {
  // Node sees the first Codex argument as its would-be script name. Insert the
  // mock script slot so mock-codex receives the same process.argv shape as it
  // does through its POSIX shebang.
  const mock = fileURLToPath(new URL("./mock-codex.mjs", import.meta.url));
  process.argv.splice(1, 0, mock);
  await import(new URL("./mock-codex.mjs", import.meta.url));
  // A delayed mock schedules its completion timer and finishes evaluating.
  // Keep Node from continuing to resolve the would-be `exec` entry point;
  // mock-codex exits explicitly when its work completes.
  await new Promise(() => {});
} else if (executable === "gh.exe") {
  const argv = process.argv.slice(1);
  argv[0] = path.basename(argv[0]);
  process.stdout.write(`MOCKGH ${argv.join(" ")}\n`);
  process.exit(0);
}
