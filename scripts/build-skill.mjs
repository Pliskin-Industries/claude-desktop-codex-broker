#!/usr/bin/env node

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createZip, extractZip } from './lib/zip.mjs';

const repoRoot = path.resolve(path.dirname(process.argv[1]), '..');
const sourceRoot = path.join(repoRoot, 'skill');
const outputPath = path.join(repoRoot, 'dist', 'codex-delegation.skill');
const wrapper = 'codex-delegation/';

function sourceEntries() {
  const entries = [{ name: wrapper, data: Buffer.alloc(0), directory: true }];

  function visit(directory, relativeDirectory = '') {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.push({ name: `${wrapper}${relative}/`, data: Buffer.alloc(0), directory: true });
        visit(absolute, relative);
      } else if (child.isFile()) {
        entries.push({ name: `${wrapper}${relative}`, data: readFileSync(absolute), directory: false });
      } else {
        throw new Error(`Unsupported source entry: skill/${relative}`);
      }
    }
  }

  visit(sourceRoot);
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function verify() {
  const expected = new Map(sourceEntries().map((entry) => [entry.name, entry]));
  const actual = extractZip(readFileSync(outputPath), {
    validateName(name) {
      if (!name.startsWith(wrapper) || name.includes('../') || name.startsWith('/')) {
        throw new Error(`Invalid zip: unsafe or unexpected entry name ${name}`);
      }
    },
  });
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
    console.error('Skill archive verification failed:');
    for (const difference of differences.sort()) console.error(`  ${difference}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Verified ${actual.size} entries in ${path.relative(repoRoot, outputPath)}.`);
}

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--verify')) {
  console.error('Usage: node scripts/build-skill.mjs [--verify]');
  process.exitCode = 2;
} else if (process.argv[2] === '--verify') {
  try {
    verify();
  } catch (error) {
    console.error(`Skill archive verification failed: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  const entries = sourceEntries();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, createZip(entries));
  console.log(`Built ${path.relative(repoRoot, outputPath)} with ${entries.length} entries.`);
}
