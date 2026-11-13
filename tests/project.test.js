// Consistency checks across files that nothing else would catch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const core = require("../plugin/stashboard-core.js");
const build = require("../scripts/build.js");
const curator = require("../scripts/curator.js");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const yml = read("plugin/stashboard.yml");

function yamlList(text, key) {
  const m = text.match(new RegExp(`^(\\s*)${key}:\\s*\\n((?:\\1\\s+- .*\\n)+)`, "m"));
  return m ? [...m[2].matchAll(/- (.+)/g)].map((x) => x[1].trim()) : [];
}

test("the yml loads the core before the UI, and every listed file ships", () => {
  assert.deepEqual(yamlList(yml, "javascript"), ["stashboard-core.js", "stashboard.js"]);
  assert.deepEqual(yamlList(yml, "css"), ["stashboard.css"]);
  const shipped = build.FILES.map(([name]) => name);
  for (const file of [...yamlList(yml, "javascript"), ...yamlList(yml, "css")]) assert.ok(shipped.includes(file), file);
});

test("the CSP lets the plugin reach exactly the stash-boxes it knows", () => {
  assert.deepEqual(yamlList(yml, "connect-src"), core.KNOWN_BOXES.map((b) => b.origin));
});

test("the plugin settings in the yml are the ones the code reads", () => {
  const declared = [...yml.split(/^settings:\s*$/m)[1].matchAll(/^ {2}(\w+):\s*$/gm)].map((m) => m[1]).sort();
  const read = Object.keys(core.readSettings({})).filter((k) => k !== "layout").sort();
  assert.deepEqual(declared, read);
});

test("the package is reproducible and holds Stashboard's and Curator's files, with the right modes", () => {
  const a = build.buildPackage();
  const b = build.buildPackage();
  assert.equal(a.sha256, b.sha256);
  const files = build.unzip(a.data);
  const names = files.map((f) => f.name);
  const lock = curator.readLock();
  assert.deepEqual(names, [
    "stashboard.yml", ...build.FILES.map(([name]) => name),
    "stash-curator.js", "stash-curator.css", "launcher.py", "stashboard-launcher.py",
    "curator/explanations/realizations.json", "LICENSE-curator",
    ...lock.binaries.map((x) => x.name)
  ]);
  const executable = new Set(["launcher.py", "stashboard-launcher.py", ...lock.binaries.map((x) => x.name)]);
  for (const f of files) {
    assert.ok(f.crcOk, `${f.name} CRC`);
    assert.equal(f.mode, executable.has(f.name) ? 0o100755 : 0o100644, `${f.name} mode`);
    assert.equal(f.method, f.name.startsWith("curator-core-") ? 8 : 0, `${f.name}: binaries deflated, the rest stored`);
  }
  assert.equal(files.find((f) => f.name === "stashboard.js").data.toString("utf8"), read("plugin/stashboard.js"));
  assert.deepEqual(lock.binaries.map((x) => x.name).sort(), [
    "curator-core-darwin-amd64", "curator-core-darwin-arm64", "curator-core-linux-amd64", "curator-core-linux-arm64", "curator-core-windows-amd64.exe"
  ]);
});

test("Curator ships with Stashboard's plugin id, and nowhere else is it changed", () => {
  curator.checkPatches();
  const js = curator.adapted("plugin/stash-curator.js").toString("utf8");
  assert.ok(!/plugin_id: \\?"stash-curator\\?"/.test(js), "no operation, task or setting under the old id");
  assert.ok(js.includes('Api.register.route("/plugins/stash-curator", CuratorPage)'), "Curator's page keeps its address");
  const original = read("curator/plugin/stash-curator.js");
  assert.equal(original.length - js.length, curator.PATCHES.patches.filter((p) => p.file === "plugin/stash-curator.js").length * ("stash-curator".length - "stashboard".length));
  assert.equal(curator.readLock().sourceHash, curator.sourceHash(), "curator-core was built from this curator/ (node scripts/curator.js build-core)");
});

test("the merged manifest runs Curator's backend through Stashboard's launcher, with both UIs, settings, tasks and hooks", () => {
  const yml = curator.mergedManifest(read("plugin/stashboard.yml")).toString("utf8");
  const blocks = curator.yamlBlocks(yml);
  assert.ok(/^name: Stashboard$/m.test(yml) && /^version: /m.test(yml));
  assert.ok(yml.includes('  - "{pluginDir}/stashboard-launcher.py"') && /^interface: raw$/m.test(yml));
  assert.deepEqual(blocks.ui.filter((l) => /^ {4}- .*\.(js|css)$/.test(l)).map((l) => l.trim().slice(2)),
    ["stashboard-core.js", "stashboard.js", "stash-curator.js", "stashboard.css", "stash-curator.css"]);
  const settings = [...yml.split(/^settings:\s*$/m)[1].split(/^tasks:/m)[0].matchAll(/^ {2}(\w+):\s*$/gm)].map((m) => m[1]);
  assert.ok(settings.includes("hideNativeRows") && settings.includes("databasePath"), "Stashboard's and Curator's settings");
  assert.equal(new Set(settings).size, settings.length, "no setting twice");
  assert.ok(blocks.tasks.some((l) => /Sync and build recommendations/.test(l)) && blocks.hooks.some((l) => /entity-sync/.test(l)));
  assert.ok(!/stash-curator\.yml|plugin_id: "stash-curator"/.test(yml));
});

test("crc32 matches the standard check value", () => {
  assert.equal(build.crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("index.yml points at this version's release with the package's SHA-256", () => {
  assert.deepEqual(build.checkIndex(build.buildPackage()), [], "run: node scripts/build.js --write-index");
});

test("the newest CHANGELOG entry is the plugin version", () => {
  assert.equal(read("CHANGELOG.md").match(/^## (\S+)/m)[1], build.pluginVersion());
});

test("the Required Notices read the same in LICENSE, README and the plugin's UI", () => {
  const notices = [...read("LICENSE").matchAll(/^Required Notice: (.+)$/gm)].map((m) => m[1]);
  assert.equal(notices.length, 2);
  const flat = (s) => s.replace(/<[^>]+>/g, "").replace(/\*\*/g, "").replace(/^> ?/gm, "").replace(/\s+/g, " ");
  // The UI builds the text out of h() calls; join its string literals.
  const ui = [...read("plugin/stashboard.js").split('"stashboard-notice"')[1].split("Modal.Footer")[0].matchAll(/"([^"]*)"/g)]
    .map((m) => m[1]).join("");
  const vibecoded = notices[1];
  assert.ok(flat(read("README.md")).includes(vibecoded), "README.md");
  assert.ok(ui.includes(vibecoded), "Customise dialog");
  assert.ok(ui.includes("Copyright 2026 brewing8309") && ui.includes("github.com/brewing8309/stashboard"), "Customise dialog copyright");
  assert.ok(flat(read("README.md")).includes(notices[0].replace(" — https://github.com/brewing8309/stashboard", "")), "README.md copyright");
});

test("the plugin's description is the same in the yml and index.yml", () => {
  const description = yml.match(/^description:\s*(.+)$/m)[1];
  assert.ok(read("index.yml").includes(`description: "${description.replace(/"/g, "\\\"")}"`));
});
