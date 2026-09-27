#!/usr/bin/env node
// Regenerate the root package-lock.json from server/package-lock.json.
//
//   node scripts/sync-plugin-lock.mjs
//
// The root package.json/package-lock.json exist only for the Claude Code
// plugin: Claude Code runs `npm ci --ignore-scripts` at the plugin root, and
// server/ resolves the result from there. The plugin must get exactly the
// dependency tree the test suite runs against, which is server/'s lockfile.
// A fresh `npm install` at the root would re-resolve to newer versions, so
// copy the server's tree and only rewrite the root entry. Run it after any
// change to server/package.json or server/package-lock.json; the test
// "plugin manifest points at real files..." fails until you do.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

const pkg = read("package.json");
const server = read("server/package.json");
if (JSON.stringify(pkg.dependencies) !== JSON.stringify(server.dependencies)) {
  pkg.dependencies = server.dependencies;
  fs.writeFileSync(path.join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  console.log("package.json: dependencies copied from server/package.json");
}

const lock = read("server/package-lock.json");
lock.name = pkg.name;
lock.version = pkg.version;
lock.packages[""] = { name: pkg.name, version: pkg.version, license: pkg.license, dependencies: pkg.dependencies };
fs.writeFileSync(path.join(ROOT, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
console.log(`package-lock.json: ${Object.keys(lock.packages).length - 1} packages from server/package-lock.json`);
