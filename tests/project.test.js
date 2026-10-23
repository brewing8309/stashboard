// Consistency checks across files that nothing else would catch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const core = require("../plugin/stashboard-core.js");
const build = require("../scripts/build.js");

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

test("the package is reproducible and holds exactly the plugin files, readable by everyone", () => {
  const a = build.buildPackage();
  const b = build.buildPackage();
  assert.equal(a.sha256, b.sha256);
  const files = build.unzip(a.data);
  assert.deepEqual(files.map((f) => f.name), build.FILES.map(([name]) => name));
  for (const f of files) {
    assert.equal(f.method, 0, `${f.name} is stored`);
    assert.equal(f.mode, 0o100644, `${f.name} mode`);
    assert.ok(f.crcOk, `${f.name} CRC`);
    assert.ok(!f.name.includes("/"), `${f.name} sits at the zip's root, as Stash expects`);
  }
  assert.equal(files.find((f) => f.name === "stashboard.js").data.toString("utf8"), read("plugin/stashboard.js"));
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
