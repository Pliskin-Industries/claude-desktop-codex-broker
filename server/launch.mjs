// Extension launcher. The .mcpb bundle is a snapshot; this lets the installed
// extension run the broker from a live git checkout instead, so a server
// change is `git pull` + a Claude Desktop tray-restart — no rebuild, no
// reinstall (docs/LESSONS.md #3 for why the restart is still needed).
//
// The checkout comes from CODEX_BROKER_REPO, which the manifest fills from the
// extension's "Broker checkout" setting. It is used only if it holds a
// server/server.mjs AND an installed MCP SDK; otherwise the bundled server
// runs and stderr says so. Claude Code CLI registrations do not use this file
// — they already point at a checkout.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = (process.env.CODEX_BROKER_REPO || "").trim();
const checkoutServer = repo ? path.join(repo, "server", "server.mjs") : null;
const checkoutSdk = repo ? path.join(repo, "server", "node_modules", "@modelcontextprotocol", "sdk", "package.json") : null;

let target;
if (checkoutServer && fs.existsSync(checkoutServer) && fs.existsSync(checkoutSdk)) {
  target = pathToFileURL(checkoutServer).href;
  process.stderr.write(`codex-broker launcher: running from checkout ${checkoutServer}\n`);
} else {
  target = new URL("./server.mjs", import.meta.url).href;
  const why = !repo
    ? "no checkout configured"
    : !fs.existsSync(checkoutServer)
      ? `no server/server.mjs under ${repo}`
      : `no server/node_modules under ${repo} (run: npm ci --prefix server)`;
  process.stderr.write(`codex-broker launcher: running bundled server (${why})\n`);
}

await import(target);
