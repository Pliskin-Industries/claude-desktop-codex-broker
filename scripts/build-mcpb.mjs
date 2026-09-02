#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createZip, extractZip } from './lib/zip.mjs';

const repoRoot = path.resolve(path.dirname(process.argv[1]), '..');
const serverRoot = path.join(repoRoot, 'server');
const nodeModulesRoot = path.join(serverRoot, 'node_modules');
const outputPath = path.join(repoRoot, 'dist', 'codex-broker.mcpb');

// Dependencies ship only what the extension needs at runtime. Node never reads
// TypeScript declarations or source maps, and they are ~1,200 of the files in a
// full install. The previously published bundle excluded both categories
// outright — 0 of each across its 2,257 entries — so this reproduces a policy
// the artifact already had rather than inventing one.
const RUNTIME_EXCLUDED = /\.d\.ts$|\.map$/;

// node_modules/.bin holds CLI launcher shims the extension never invokes — it
// is started as `node server/server.mjs`. Excluding it also keeps the bundle
// platform-independent: npm writes real .cmd/.ps1 shims there on Windows but
// symlinks on POSIX, so including it would make the artifact differ by build
// host and crash the packager on the symlinks. The previously published bundle
// contained no .bin entries either.
const EXCLUDED_DIRS = new Set(['.bin']);

function sourceEntries() {
  if (!existsSync(nodeModulesRoot)) {
    throw new Error('server/node_modules is missing; run: npm ci --prefix server --omit=dev');
  }

  const entries = [
    { name: 'manifest.json', data: readFileSync(path.join(repoRoot, 'manifest.json')), directory: false },
    { name: 'package.json', data: readFileSync(path.join(serverRoot, 'package.json')), directory: false },
    { name: 'server/server.mjs', data: readFileSync(path.join(serverRoot, 'server.mjs')), directory: false },
    { name: 'server/launch.mjs', data: readFileSync(path.join(serverRoot, 'launch.mjs')), directory: false },
  ];

  function visit(directory, bundleDirectory) {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const name = `${bundleDirectory}/${child.name}`;
      if (child.isDirectory()) {
        if (EXCLUDED_DIRS.has(child.name)) continue;
        visit(absolute, name);
      } else if (child.isFile()) {
        if (RUNTIME_EXCLUDED.test(child.name)) continue;
        entries.push({ name, data: readFileSync(absolute), directory: false });
      } else throw new Error(`Unsupported source entry: ${path.relative(repoRoot, absolute)}`);
    }
  }

  visit(nodeModulesRoot, 'node_modules');
  for (const child of readdirSync(path.join(serverRoot, 'lib'), { withFileTypes: true })) {
    if (child.isFile() && child.name.endsWith('.mjs')) {
      entries.push({
        name: `server/lib/${child.name}`,
        data: readFileSync(path.join(serverRoot, 'lib', child.name)),
        directory: false,
      });
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function validateBundleName(name) {
  if (!name || name.startsWith('/') || name.includes('../') || name.endsWith('/')) {
    throw new Error(`Invalid zip: unsafe or unexpected entry name ${name}`);
  }
}

function verify() {
  const expected = new Map(sourceEntries().map((entry) => [entry.name, entry]));
  const actual = extractZip(readFileSync(outputPath), { validateName: validateBundleName });
  const differences = [];
  for (const [name, entry] of expected) {
    const archived = actual.get(name);
    if (!archived) differences.push(`missing: ${name}`);
    else if (entry.directory !== archived.directory || !entry.data.equals(archived.data)) differences.push(`differing: ${name}`);
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) differences.push(`extra: ${name}`);
  }
  if (differences.length) {
    console.error('MCPB archive verification failed:');
    for (const difference of differences.sort()) console.error(`  ${difference}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Verified ${actual.size} entries in ${path.relative(repoRoot, outputPath)}.`);
}

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--verify')) {
  console.error('Usage: node scripts/build-mcpb.mjs [--verify]');
  process.exitCode = 2;
} else if (process.argv[2] === '--verify') {
  try {
    verify();
  } catch (error) {
    console.error(`MCPB archive verification failed: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  try {
    const entries = sourceEntries();
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, createZip(entries));
    console.log(`Built ${path.relative(repoRoot, outputPath)} with ${entries.length} entries.`);
  } catch (error) {
    console.error(`MCPB archive build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
