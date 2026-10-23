#!/usr/bin/env node
/*
 * Builds the plugin package and keeps index.yml (the plugin source Stash
 * reads) in step with it.
 *
 *   node scripts/build.js                 write dist/stashboard-<version>.zip
 *   node scripts/build.js --write-index   …and point index.yml at it (version, date, sha256)
 *   node scripts/build.js --check         fail unless index.yml matches the package
 *
 * The zip is deterministic — stored, not compressed, with fixed timestamps
 * and permissions — so its SHA-256 is known before the release exists and
 * CI rebuilds exactly the file index.yml promises. No dependencies.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const REPO = "brewing8309/stashboard";

// [path in the zip, source path in the repo]. Stash unpacks these into
// plugins/<source>/stashboard/ and keeps each file's mode from the zip.
const FILES = [
  ["stashboard.yml", "plugin/stashboard.yml"],
  ["stashboard-core.js", "plugin/stashboard-core.js"],
  ["stashboard.js", "plugin/stashboard.js"],
  ["stashboard.css", "plugin/stashboard.css"],
  ["LICENSE", "LICENSE"]
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel));
}

function pluginVersion() {
  const m = read("plugin/stashboard.yml").toString("utf8").match(/^version:\s*(\S+)\s*$/m);
  if (!m) throw new Error("plugin/stashboard.yml has no version");
  return m[1];
}

function pluginDescription() {
  const m = read("plugin/stashboard.yml").toString("utf8").match(/^description:\s*(.+?)\s*$/m);
  return m ? m[1] : "";
}

function packageName(version) {
  return `stashboard-${version}.zip`;
}

function releaseUrl(version) {
  return `https://github.com/${REPO}/releases/download/v${version}/${packageName(version)}`;
}

/* ------------------------------------------------------------------ *
 * Minimal zip writer (method 0, "stored")                             *
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;                         // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1;   // 1980-01-01
const UNIX_FILE_0644 = (0o100644 << 16) >>> 0;
const MADE_BY_UNIX = (3 << 8) | 20;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 names
    local.writeUInt16LE(0, 8);         // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);      // extra
    central.writeUInt16LE(0, 32);      // comment
    central.writeUInt16LE(0, 34);      // disk
    central.writeUInt16LE(0, 36);      // internal attributes
    central.writeUInt32LE(UNIX_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// Reads back what zip() writes (stored entries only) — for the tests.
function unzip(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(endAt + 10);
  let at = buf.readUInt32LE(endAt + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const mode = buf.readUInt32LE(at + 38) >>> 16;
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    files.push({ name, method, mode, data, crcOk: crc32(data) === crc });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function buildPackage() {
  const version = pluginVersion();
  const data = zip(FILES.map(([name, src]) => ({ name, data: read(src) })));
  return { version, name: packageName(version), data, sha256: crypto.createHash("sha256").update(data).digest("hex") };
}

/* ------------------------------------------------------------------ *
 * index.yml                                                           *
 * ------------------------------------------------------------------ */

const INDEX = "index.yml";

// Stash compares `date` to decide whether an update is available (not the
// version), so every release needs a later date. Format per Stash's
// pkg.TimeFormat.
function stashTime(date) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function renderIndex(pkg, date) {
  const description = pluginDescription().replace(/"/g, "\\\"");
  return [
    "# Stash plugin source for Stashboard. Add this file's raw URL under",
    "# Settings → Plugins → Available Plugins → Add Source in Stash:",
    `# https://raw.githubusercontent.com/${REPO}/main/index.yml`,
    "# Written by `node scripts/build.js --write-index`; don't edit by hand.",
    `- id: stashboard`,
    `  name: Stashboard`,
    `  metadata:`,
    `    description: "${description}"`,
    `  version: ${pkg.version}`,
    `  date: ${date}`,
    `  path: ${releaseUrl(pkg.version)}`,
    `  sha256: ${pkg.sha256}`,
    ""
  ].join("\n");
}

function readIndex() {
  const text = read(INDEX).toString("utf8");
  const field = (key) => {
    const m = text.match(new RegExp(`^  ${key}:\\s*(.+?)\\s*$`, "m"));
    return m ? m[1] : null;
  };
  return { text, id: (text.match(/^- id:\s*(\S+)/m) || [])[1] || null, version: field("version"), date: field("date"), path: field("path"), sha256: field("sha256") };
}

function checkIndex(pkg) {
  const index = readIndex();
  const problems = [];
  if (index.id !== "stashboard") problems.push(`id is ${index.id}, expected stashboard`);
  if (index.version !== pkg.version) problems.push(`version is ${index.version}, the plugin is ${pkg.version}`);
  if (index.path !== releaseUrl(pkg.version)) problems.push(`path is ${index.path}, expected ${releaseUrl(pkg.version)}`);
  if (index.sha256 !== pkg.sha256) problems.push(`sha256 is ${index.sha256}, the package is ${pkg.sha256}`);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(index.date || "")) problems.push(`date "${index.date}" isn't YYYY-MM-DD HH:MM:SS`);
  if (index.text !== renderIndex(pkg, index.date)) problems.push("index.yml differs from what --write-index writes");
  return problems;
}

function main(args) {
  const pkg = buildPackage();
  const out = path.join(ROOT, "dist", pkg.name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pkg.data);
  console.log(`${path.relative(ROOT, out)}  ${pkg.data.length} bytes  sha256 ${pkg.sha256}`);

  if (args.includes("--write-index")) {
    fs.writeFileSync(path.join(ROOT, INDEX), renderIndex(pkg, stashTime(new Date())));
    console.log(`${INDEX} now points at v${pkg.version}`);
  }
  if (args.includes("--check")) {
    const problems = checkIndex(pkg);
    if (problems.length) {
      console.error(`${INDEX} doesn't match the package:\n  - ${problems.join("\n  - ")}\nRun: node scripts/build.js --write-index`);
      process.exit(1);
    }
    console.log(`${INDEX} matches the package`);
  }
}

module.exports = { FILES, REPO, pluginVersion, packageName, releaseUrl, crc32, zip, unzip, buildPackage, stashTime, renderIndex, readIndex, checkIndex };

if (require.main === module) main(process.argv.slice(2));
