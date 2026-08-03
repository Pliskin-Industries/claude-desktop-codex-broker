#!/usr/bin/env node

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(process.argv[1]), '..');
const sourceRoot = path.join(repoRoot, 'skill');
const outputPath = path.join(repoRoot, 'dist', 'codex-delegation.skill');
const wrapper = 'codex-delegation/';
const dosTime = 0;
const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
const utf8Flag = 0x0800;

function makeCrcTable() {
  return Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return crc >>> 0;
  });
}

const crcTable = makeCrcTable();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

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

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.directory || entry.data.length === 0 ? 0 : 8;
    const compressed = method === 8 ? deflateRawSync(entry.data, { level: 9 }) : entry.data;
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((entry.directory ? 0o40755 : 0o100644) << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function findEndRecord(archive) {
  const minimum = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Invalid zip: end-of-central-directory record not found');
}

function extractZip(archive) {
  const endOffset = findEndRecord(archive);
  const count = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize > endOffset) throw new Error('Invalid zip: central directory is out of bounds');

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid zip: bad central-directory entry ${index + 1}`);
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > archive.length) throw new Error(`Invalid zip: truncated name for entry ${index + 1}`);
    const name = archive.subarray(cursor + 46, nameEnd).toString((flags & utf8Flag) ? 'utf8' : 'latin1');
    if (entries.has(name)) throw new Error(`Invalid zip: duplicate entry ${name}`);
    if (name.includes('\\')) throw new Error(`Invalid zip: backslash in entry name ${name}`);
    if (!name.startsWith(wrapper) || name.includes('../') || name.startsWith('/')) {
      throw new Error(`Invalid zip: unsafe or unexpected entry name ${name}`);
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid zip: bad local header for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > archive.length) throw new Error(`Invalid zip: truncated data for ${name}`);
    const compressed = archive.subarray(dataOffset, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`Invalid zip: unsupported compression method ${method} for ${name}`);
    if (data.length !== uncompressedSize) throw new Error(`Invalid zip: size mismatch for ${name}`);
    if (crc32(data) !== expectedCrc) throw new Error(`Invalid zip: CRC mismatch for ${name}`);
    entries.set(name, { data, directory: name.endsWith('/') });
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('Invalid zip: central-directory size mismatch');
  return entries;
}

function verify() {
  const expected = new Map(sourceEntries().map((entry) => [entry.name, entry]));
  const actual = extractZip(readFileSync(outputPath));
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
