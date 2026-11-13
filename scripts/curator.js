#!/usr/bin/env node
/*
 * Stash Curator inside Stashboard. curator/ is an unchanged copy of
 * https://github.com/brewing8309/stash-curator (git subtree, see CURATOR.md);
 * everything Stashboard does differently lives here and in curator-adapter/:
 *
 *   - patches.json: the few places that name Curator's plugin id
 *   - stashboard-launcher.py: takes over an old Curator's data, then runs
 *     Curator's own launcher
 *   - core.lock.json: the curator-core binaries for this curator/, built
 *     once and kept as release assets, already deflated, so the package
 *     stays byte for byte reproducible
 *
 *   node scripts/curator.js build-core [--upload]
 *       build curator-core for every platform from the patched curator/
 *       (needs Go and Python; zig is fetched by Curator's own build script),
 *       write curator-adapter/core.lock.json, and with --upload attach the
 *       binaries to a GitHub release named after them
 *   node scripts/curator.js check
 *       fail unless core.lock.json was built from the current curator/
 *
 * No dependencies.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CURATOR = path.join(ROOT, "curator");
const ADAPTER = path.join(ROOT, "curator-adapter");
const LOCK = path.join(ADAPTER, "core.lock.json");
const CACHE = path.join(ROOT, ".cache", "curator-core");
const REPO = "brewing8309/stashboard";

const PATCHES = JSON.parse(fs.readFileSync(path.join(ADAPTER, "patches.json"), "utf8"));

/* ------------------------------------------------------------------ *
 * Patching                                                            *
 * ------------------------------------------------------------------ */

function patchesFor(rel) {
  return PATCHES.patches.filter((p) => p.file === rel);
}

// A file of curator/ as Stashboard ships it.
function adapted(rel) {
  let text = fs.readFileSync(path.join(CURATOR, rel), "utf8");
  for (const p of patchesFor(rel)) {
    const found = text.split(p.find).length - 1;
    if (found !== p.count) {
      throw new Error(`curator/${rel}: expected ${p.count}× ${JSON.stringify(p.find)} (${p.why}), found ${found}. Curator changed here; update curator-adapter/patches.json.`);
    }
    text = text.split(p.find).join(p.replace);
  }
  return Buffer.from(text, "utf8");
}

function checkPatches() {
  for (const file of new Set(PATCHES.patches.map((p) => p.file))) adapted(file);
}

// The files a core build depends on, for the lock's source hash.
function coreSources() {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(CURATOR, full).split(path.sep).join("/");
      if (name === "bin" || name.startsWith(".")) continue;
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (!rel.endsWith("_test.go")) files.push(rel);
    }
  };
  walk(path.join(CURATOR, "core"));
  return [...files, "scripts/build_plugin.py", "pyproject.toml"];
}

function sourceHash() {
  const hash = crypto.createHash("sha256");
  for (const rel of coreSources()) {
    hash.update(rel).update("\0").update(patchesFor(rel).length ? adapted(rel) : fs.readFileSync(path.join(CURATOR, rel))).update("\0");
  }
  return hash.digest("hex");
}

/* ------------------------------------------------------------------ *
 * The merged plugin manifest                                          *
 * ------------------------------------------------------------------ */

// Top-level blocks of a (simple, block-style) YAML file, by key.
function yamlBlocks(text) {
  const blocks = {};
  let key = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):(.*)$/);
    if (m) {
      key = m[1];
      blocks[key] = [line];
    } else if (key) {
      blocks[key].push(line);
    }
  }
  for (const k of Object.keys(blocks)) {
    while (blocks[k].length && !blocks[k][blocks[k].length - 1].trim()) blocks[k].pop();
  }
  return blocks;
}

function listUnder(block, name) {
  const out = [];
  let inside = false;
  for (const line of block) {
    if (new RegExp(`^  ${name}:\\s*$`).test(line)) inside = true;
    else if (inside && /^ {4}- /.test(line)) out.push(line.replace(/^ {4}- /, "").trim());
    else if (inside && /^ {2}\S/.test(line)) inside = false;
  }
  return out;
}

// Stashboard's manifest (plugin/stashboard.yml: name, version, its UI and
// settings) with Curator's backend: exec through Stashboard's launcher, its
// interface, UI files, settings, tasks and hooks.
function mergedManifest(stashboardYml) {
  const own = yamlBlocks(stashboardYml);
  const theirs = yamlBlocks(adaptedText("plugin/stash-curator.yml"));
  const ui = own.ui.slice();
  const js = listUnder(theirs.ui, "javascript");
  const css = listUnder(theirs.ui, "css");
  const insertAfter = (label, items) => {
    const at = ui.findIndex((l) => new RegExp(`^  ${label}:\\s*$`).test(l));
    let end = at + 1;
    while (end < ui.length && /^ {4}- /.test(ui[end])) end++;
    ui.splice(end, 0, ...items.map((f) => `    - ${f}`));
  };
  insertAfter("javascript", js);
  insertAfter("css", css);
  const settings = [...own.settings, "  # Stash Curator's settings, from its manifest in curator/plugin/:", ...theirs.settings.slice(1)];
  const out = [
    own.name.join("\n"),
    own.description.join("\n"),
    own.version.join("\n"),
    own.url.join("\n"),
    "",
    "# Stash Curator's backend (curator/), started through Stashboard's launcher.",
    "exec:",
    "  - python",
    "  - -S",
    "  - \"{pluginDir}/stashboard-launcher.py\"",
    "  - \"{pluginDir}\"",
    theirs.interface.join("\n"),
    theirs.errLog.join("\n"),
    "",
    ui.join("\n"),
    "",
    settings.join("\n"),
    "",
    theirs.tasks.join("\n"),
    "",
    theirs.hooks.join("\n"),
    ""
  ];
  return Buffer.from(out.join("\n"), "utf8");
}

function adaptedText(rel) {
  return adapted(rel).toString("utf8");
}

/* ------------------------------------------------------------------ *
 * Package contents                                                    *
 * ------------------------------------------------------------------ */

function readLock() {
  return JSON.parse(fs.readFileSync(LOCK, "utf8"));
}

function blobUrl(lock, name) {
  return `https://github.com/${REPO}/releases/download/${lock.release}/${name}.deflate`;
}

// The deflated binary, from the cache or the release, checked against the lock.
function coreBlob(lock, entry) {
  const cached = path.join(CACHE, `${entry.name}.deflate`);
  let data = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
  const ok = (buf) => buf && crypto.createHash("sha256").update(buf).digest("hex") === entry.sha256;
  if (!ok(data)) {
    const url = blobUrl(lock, entry.name);
    data = execFileSync("curl", ["-fsSL", "--retry", "3", url], { maxBuffer: 256 * 1024 * 1024 });
    if (!ok(data)) throw new Error(`${url} doesn't match core.lock.json`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(cached, data);
  }
  return data;
}

// Every Curator file in the package: [{ name, data, mode?, deflated? }].
function packageEntries() {
  const lock = readLock();
  const files = [
    { name: "stash-curator.js", data: adapted("plugin/stash-curator.js") },
    { name: "stash-curator.css", data: fs.readFileSync(path.join(CURATOR, "plugin/stash-curator.css")) },
    { name: "launcher.py", data: fs.readFileSync(path.join(CURATOR, "plugin/launcher.py")), mode: 0o755 },
    { name: "stashboard-launcher.py", data: fs.readFileSync(path.join(ADAPTER, "stashboard-launcher.py")), mode: 0o755 },
    { name: "curator/explanations/realizations.json", data: fs.readFileSync(path.join(CURATOR, "curator/explanations/realizations.json")) },
    { name: "LICENSE-curator", data: fs.readFileSync(path.join(CURATOR, "LICENSE")) }
  ];
  for (const entry of lock.binaries) {
    files.push({ name: entry.name, mode: 0o755, deflated: { data: coreBlob(lock, entry), size: entry.size, crc: entry.crc32 } });
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * Building curator-core                                               *
 * ------------------------------------------------------------------ */

function copyAdaptedTree(dest) {
  fs.cpSync(CURATOR, dest, { recursive: true, filter: (src) => !/[\\/](\.git|\.tmp|dist|bin)$/.test(src) });
  for (const file of new Set(PATCHES.patches.map((p) => p.file))) fs.writeFileSync(path.join(dest, file), adapted(file));
}

function buildCore(upload) {
  const crc32 = require("./build.js").crc32;
  const hash = sourceHash();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "stashboard-curator-"));
  copyAdaptedTree(work);
  console.log(`Building curator-core in ${work} …`);
  execFileSync("python3", ["-c", "import sys; sys.path.insert(0, 'scripts'); import build_plugin; print('\\n'.join(map(str, build_plugin.core_binaries())))"],
    { cwd: work, stdio: ["ignore", "inherit", "inherit"] });
  const bin = path.join(work, "core", "bin");
  const names = fs.readdirSync(bin).filter((n) => n.startsWith("curator-core-")).sort();
  fs.mkdirSync(CACHE, { recursive: true });
  const binaries = names.map((name) => {
    const raw = fs.readFileSync(path.join(bin, name));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    fs.writeFileSync(path.join(CACHE, `${name}.deflate`), deflated);
    return { name, size: raw.length, crc32: crc32(raw), sha256: crypto.createHash("sha256").update(deflated).digest("hex") };
  });
  const lock = {
    comment: "Written by `node scripts/curator.js build-core`. The curator-core binaries for curator/ as patched by curator-adapter/, deflated, attached to the release below.",
    sourceHash: hash,
    curatorVersion: fs.readFileSync(path.join(CURATOR, "pyproject.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)[1],
    release: `curator-core-${hash.slice(0, 12)}`,
    binaries
  };
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`core.lock.json: ${lock.release}, ${binaries.length} binaries`);
  if (upload) {
    const assets = binaries.map((b) => path.join(CACHE, `${b.name}.deflate`));
    execFileSync("gh", ["release", "create", lock.release, "--repo", REPO, "--prerelease",
      "--title", `curator-core ${lock.curatorVersion} (${hash.slice(0, 12)})`,
      "--notes", `Stash Curator ${lock.curatorVersion}'s backend binaries for Stashboard, built from curator/ with curator-adapter/patches.json. Raw deflate streams; Stashboard's build puts them into its package as they are.`,
      ...assets], { stdio: "inherit" });
  }
  fs.rmSync(work, { recursive: true, force: true });
}

function check() {
  checkPatches();
  const lock = readLock();
  if (lock.sourceHash !== sourceHash()) {
    throw new Error("curator-adapter/core.lock.json is for another curator/ (or patches): run `node scripts/curator.js build-core --upload`.");
  }
  console.log(`curator-core ${lock.release} matches curator/`);
}

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "build-core") buildCore(rest.includes("--upload"));
    else if (command === "check") check();
    else throw new Error("usage: node scripts/curator.js build-core [--upload] | check");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { PATCHES, adapted, checkPatches, sourceHash, mergedManifest, yamlBlocks, readLock, packageEntries, copyAdaptedTree };
