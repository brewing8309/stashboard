#!/usr/bin/env node
/*
 * End-to-end test against a real Stash.
 *
 *   STASH_BIN=/path/to/stash-linux [CHROMIUM_PATH=/usr/bin/chromium] node tests/e2e/run.js
 *
 * Starts Stash on an empty temporary library, installs Stashboard the way a
 * user does (a plugin source serving index.yml and the zip, then Install —
 * which checks the SHA-256), adds a Curator test double and a fictional
 * library, fakes StashDB in the browser, and walks through the dashboard:
 * every kind of row, ownership marks, caching, Refresh, Customise, the
 * settings, German, failures, and switching the plugin off again.
 *
 * SCREENSHOTS=dir also saves screenshots there (the README's come from here).
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const build = require("../../scripts/build.js");
const { seed, gql, STASHDB } = require("./seed.js");
const mock = require("./stashbox-mock.js");

const API_KEY = "test-api-key";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok || detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function startStash(bin, dir, port) {
  for (const d of ["generated", "cache", "blobs", "plugins", "media"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yml"), [
    `database: ${path.join(dir, "stash-go.sqlite")}`,
    `generated: ${path.join(dir, "generated")}`,
    `cache: ${path.join(dir, "cache")}`,
    `blobs_path: ${path.join(dir, "blobs")}`,
    "blobs_storage: FILESYSTEM",
    `plugins_path: ${path.join(dir, "plugins")}`,
    "stash:",
    `  - path: ${path.join(dir, "media")}`,
    "host: 127.0.0.1",
    `port: ${port}`,
    ""
  ].join("\n"));
  const log = fs.openSync(path.join(dir, "stash.log"), "w");
  const proc = spawn(bin, ["--config", path.join(dir, "config.yml"), "--nobrowser"], { cwd: dir, stdio: ["ignore", log, log] });
  const base = `http://127.0.0.1:${port}`;
  await waitFor("Stash to start", async () => {
    const d = await gql(base, "{ systemStatus { status } }");
    return d.systemStatus.status === "OK";
  });
  return { proc, base };
}

// Serves the test's plugin source: index.yml as build.js writes it, but
// pointing at this server's copy of the zip.
function servePackage(port) {
  const pkg = build.buildPackage();
  const index = build.renderIndex(pkg, build.stashTime(new Date()))
    .replace(/^ {2}path: .*$/m, `  path: http://127.0.0.1:${port}/${pkg.name}`);
  const server = http.createServer((req, res) => {
    if (req.url === "/index.yml") {
      res.writeHead(200, { "Content-Type": "text/yaml" });
      res.end(index);
    } else if (req.url === `/${pkg.name}`) {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(pkg.data);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, pkg, url: `http://127.0.0.1:${port}/index.yml` })));
}

async function installFromSource(base, sourceUrl, pkg) {
  await gql(base, "mutation($input: ConfigGeneralInput!) { configureGeneral(input: $input) { pluginPackageSources { url } } }",
    { input: { pluginPackageSources: [{ name: "Stashboard (test)", url: sourceUrl, local_path: "stashboard-test" }] } });
  const available = await gql(base, "query($s: String!) { availablePackages(type: Plugin, source: $s) { package_id name version metadata } }", { s: sourceUrl });
  const listed = available.availablePackages.find((p) => p.package_id === "stashboard");
  check("the plugin source lists Stashboard with its version and description",
    listed && listed.version === pkg.version && /dashboard/i.test((listed.metadata || {}).description || ""), available.availablePackages);

  const job = (await gql(base, "mutation($p: [PackageSpecInput!]!) { installPackages(type: Plugin, packages: $p) }",
    { p: [{ id: "stashboard", sourceURL: sourceUrl }] })).installPackages;
  const done = await waitFor("the install job", async () => {
    const j = (await gql(base, "query($id: ID!) { findJob(input: { id: $id }) { status error } }", { id: job })).findJob;
    return j && ["FINISHED", "FAILED", "CANCELLED"].includes(j.status) ? j : null;
  });
  check("Stash installs the package (SHA-256 accepted)", done.status === "FINISHED" && !done.error, done);
  await gql(base, "mutation { reloadPlugins }");
  const plugins = (await gql(base, "{ plugins { id enabled version } }")).plugins || [];
  const installed = plugins.find((p) => p.id === "stashboard");
  check("Stashboard is loaded and enabled", installed && installed.enabled && installed.version === pkg.version, plugins);
}

// Runs SQL on an SQLite file with Python's sqlite3 (Stash needs Python for
// Curator anyway) and returns what it prints.
function sqlite(file, sql) {
  return require("node:child_process").execFileSync("python3", ["-c",
    "import sqlite3, sys\ncon = sqlite3.connect(sys.argv[1])\nfor row in con.executescript(sys.argv[2]) if sys.argv[2].strip().upper().startswith(('CREATE', 'INSERT')) else con.execute(sys.argv[2]):\n    print(*row)\ncon.commit()",
    file, sql], { encoding: "utf8" });
}

function findPluginDir(root, manifest) {
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (fs.existsSync(path.join(full, manifest))) return full;
    const deeper = findPluginDir(full, manifest);
    if (deeper) return deeper;
  }
  return null;
}

async function pluginSettings(base) {
  return (await gql(base, "{ configuration { plugins(include: [\"stashboard\"]) } }")).configuration.plugins.stashboard || {};
}

async function setPluginSettings(base, changes) {
  const current = await pluginSettings(base);
  await gql(base, "mutation($i: Map!) { configurePlugin(plugin_id: \"stashboard\", input: $i) }", { i: { ...current, ...changes } });
}

/* ------------------------------------------------------------------ *
 * Browser helpers                                                     *
 * ------------------------------------------------------------------ */

async function openDashboard(page, base) {
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stashboard-toolbar", { timeout: 30000 });
  await settle(page);
}

async function openDiscover(page, base) {
  await page.goto(`${base}/?stashboard=discover`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stashboard-toolbar", { timeout: 30000 });
  await settle(page);
}

// Brings every lazy row near the screen once, then lets them load.
async function settle(page) {
  await page.waitForSelector(".stashboard-toolbar", { timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 900);
    await sleep(150);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector(".stashboard-skeleton, .stashboard-spotlight-loading"), null, { timeout: 60000 });
  await sleep(300);
}

function rowsOnPage(page) {
  return page.evaluate(() => [...document.querySelectorAll(".stashboard [data-row]")]
    .filter((el) => !el.classList.contains("stashboard-row-empty"))
    .map((el) => el.getAttribute("data-row")));
}

function rowInfo(page, id) {
  return page.evaluate((rowId) => {
    const el = document.querySelector(`.stashboard [data-row="${rowId}"]`);
    if (!el) return null;
    const title = el.querySelector("h2");
    const icon = title && title.querySelector(".stashboard-module-icon");
    return {
      title: title ? title.textContent.slice(icon ? icon.textContent.length : 0).trim() : "",
      message: (el.querySelector(".stashboard-row-message") || {}).textContent || "",
      scenes: [...el.querySelectorAll(".stashboard-scene")].map((c) => {
        const a = c.querySelector("a[href*='/scenes/']");
        return { id: c.getAttribute("data-scene"), title: (c.querySelector(".stashboard-scene-title") || c).textContent.trim(), href: a ? a.getAttribute("href") : "" };
      }),
      external: [...el.querySelectorAll(".stashboard-ext-card")].map((c) => ({
        title: c.querySelector(".stashboard-ext-title").textContent.trim(),
        owned: c.classList.contains("is-owned"),
        href: c.querySelector(".stashboard-ext-thumb").getAttribute("href"),
        badge: (c.querySelector(".stashboard-badge") || {}).textContent || ""
      }))
    };
  }, id);
}

/* ------------------------------------------------------------------ *
 * The walk-through                                                    *
 * ------------------------------------------------------------------ */

async function main() {
  // Stash runs inside the temporary directory, so a relative path has to be
  // resolved first.
  const bin = process.env.STASH_BIN && path.resolve(process.env.STASH_BIN);
  if (!bin || !fs.existsSync(bin)) throw new Error("Set STASH_BIN to a Stash binary.");
  const shots = process.env.SCREENSHOTS || null;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stashboard-e2e-"));
  const [stashPort, pkgPort] = [await freePort(), await freePort()];
  const { proc, base } = await startStash(bin, dir, stashPort);
  const version = (await gql(base, "{ version { version } }")).version.version;
  console.log(`Stash ${version} on ${base} (data in ${dir})`);
  const { server, pkg, url } = await servePackage(pkgPort);
  let browser;

  try {
    console.log("Install");
    await installFromSource(base, url, pkg);

    fs.cpSync(path.join(__dirname, "fake-curator"), path.join(dir, "plugins", "curator-double"), { recursive: true });
    // A separately installed Stash Curator from before, with data and a setting.
    const oldCurator = path.join(dir, "plugins", "old-source", "stash-curator");
    fs.mkdirSync(path.join(oldCurator, "data"), { recursive: true });
    fs.writeFileSync(path.join(oldCurator, "stash-curator.yml"), "name: Stash Curator\ndescription: the separate plugin from before\nversion: 0.58.1\n");
    sqlite(path.join(oldCurator, "data", "curator.sqlite3"), "CREATE TABLE stashboard_e2e (marker TEXT); INSERT INTO stashboard_e2e VALUES ('from the old Curator');");
    await gql(base, "mutation { reloadPlugins }");
    await gql(base, "mutation { configurePlugin(plugin_id: \"stash-curator\", input: { hideCardRatings: true }) }");
    await gql(base, "mutation($p: Map) { configureUI(partial: $p) }", { p: { lastNoteSeen: 99999999 } });
    await gql(base, "mutation($input: ConfigGeneralInput!) { configureGeneral(input: $input) { stashBoxes { endpoint } } }",
      { input: { stashBoxes: [{ endpoint: STASHDB, api_key: API_KEY, name: "StashDB" }] } });
    await seed(base);

    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "en-US" });
    // Curator's answers for the dashboard come from the double, so they're known.
    await context.addInitScript(() => { window.__stashboardCuratorBackend = "curator-double"; });
    // Whether Stash's own front page rows ever show, and before the dashboard.
    await context.addInitScript(() => {
      window.__stashboardNative = { seen: false, early: false };
      new MutationObserver(() => {
        if (!document.querySelector(".stashboard-native")) return;
        window.__stashboardNative.seen = true;
        if (!document.querySelector(".stashboard-toolbar")) window.__stashboardNative.early = true;
      }).observe(document, { childList: true, subtree: true });
    });
    const curatorState = path.join(dir, "plugins", "curator-double", "state.json");
    const readCuratorState = () => (fs.existsSync(curatorState) ? JSON.parse(fs.readFileSync(curatorState, "utf8")) : { ready: true, dismissed: [], shortlist: [] });
    const boxRequests = [];
    const box = { fail: null };
    await context.route(`${mock.IMAGE_HOST}/**`, (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: mock.imageSvg(route.request().url()) }));
    await context.route("https://stashdb.org/scenes/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>StashDB scene</title>" }));
    await context.route("https://stashdb.org/graphql", async (route) => {
      const req = route.request();
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type,apikey", "Access-Control-Allow-Methods": "POST" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const body = JSON.parse(req.postData() || "{}");
      const input = (body.variables || {}).input || {};
      boxRequests.push({ apiKey: req.headers().apikey, input, kind: mock.kindOf(input) });
      // Like StashDB: a wrong key gets 401 and no body.
      if (req.headers().apikey !== API_KEY) return route.fulfill({ status: 401, headers: cors, body: "" });
      if (box.fail && box.fail(mock.kindOf(input))) return route.fulfill({ status: 500, headers: cors, body: "boom" });
      return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(mock.answer(input)) });
    });

    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      // Stash's own: missing images of file-less scenes, and its player
      // asking for a wake lock that headless Chromium refuses.
      if (m.type() === "error" && !/Failed to load resource|Screen Wake Lock/.test(m.text())) problems.push(`console.error: ${m.text()}`);
    });

    console.log("Dashboard");
    await openDashboard(page, base);
    check("the tab is named after the dashboard", (await page.title()) === "Stashboard | Stash", await page.title());
    check("with the separate Stash Curator still on, the dashboard says to uninstall it",
      /Uninstall the separate Stash Curator plugin/.test(await page.locator(".stashboard-notice-bar").textContent().catch(() => "")));
    const takenOver = await pluginSettings(base);
    check("the separate Curator's settings are taken over once", takenOver.hideCardRatings === true && takenOver.curatorSettingsTaken === true, takenOver);
    const rows = await rowsOnPage(page);
    check("the start page has the library's modules, in order", JSON.stringify(rows) === JSON.stringify([
      "spotlight", "local:continue", "bubbles", "curator:for_you", "local:tag_of_the_day", "local:studio_spotlight", "local:rediscover", "local:random"
    ]), rows);
    check("…two tabs, and at its end the way into Discover, with pictures of what's there",
      await page.locator(".stashboard-tabs .stashboard-tab").count() === 2 && await page.locator('.stashboard-tab.is-on[data-tab="home"]').count() === 1 &&
      await page.locator('.stashboard-teaser[href$="?stashboard=discover"]').count() === 1 && await page.locator(".stashboard-teaser-art img").count() === 5);
    check("Stash's own rows don't show up before the dashboard", await page.evaluate(() => window.__stashboardNative.seen && !window.__stashboardNative.early),
      await page.evaluate(() => window.__stashboardNative));
    const lines = await page.evaluate(() => {
      const top = (id) => Math.round(document.querySelector(`[data-row="${id}"]`).getBoundingClientRect().top);
      return { spotlight: top("spotlight"), upNext: top("local:continue") };
    });
    check("modules share lines: the spotlight next to Up next", lines.spotlight === lines.upNext, lines);

    const spotlight = await page.evaluate(() => {
      const s = document.querySelector(".stashboard-spotlight");
      return s && {
        reason: s.querySelector(".stashboard-spotlight-reason").textContent,
        title: s.querySelector(".stashboard-spotlight-title").textContent,
        play: s.querySelector(".btn-primary").getAttribute("href"),
        chips: s.querySelectorAll(".stashboard-chip").length
      };
    });
    check("spotlight shows Curator's best bet with a Play link and what it's about", spotlight && spotlight.reason === "Curator's best bet" && spotlight.title === "Fictional Scene 07" &&
      /\/scenes\/7\?autoplay=true$/.test(spotlight.play) && spotlight.chips > 0, spotlight);
    await page.click(".stashboard-spotlight-next");
    const nextPick = await page.locator(".stashboard-spotlight-title").textContent();
    check("↻ Another pick shows Curator's next best bet", nextPick !== spotlight.title && /^Fictional Scene/.test(nextPick), nextPick);
    await page.hover(".stashboard-spotlight-title");
    await page.waitForSelector(".stashboard-spotlight.is-popped .stashboard-spotlight-video", { timeout: 5000 }).catch(() => {});
    check("hovered, the spotlight grows a little and plays the preview", await page.locator(".stashboard-spotlight.is-popped .stashboard-spotlight-video").count() === 1);
    await page.mouse.move(5, 500);
    await page.hover('[data-row="curator:for_you"] .stashboard-rank >> nth=1');
    await page.waitForSelector(".stashboard-thumb.is-popped", { timeout: 5000 }).catch(() => {});
    await sleep(400);
    const popped = await page.evaluate(() => {
      const el = document.querySelector(".stashboard-thumb.is-popped");
      return el && el.getBoundingClientRect().width / el.offsetWidth;
    });
    check("hovered, a scene picture pops out bigger", popped > 1.05, popped);
    await page.mouse.move(5, 500);
    check("the top 5's number one wears a crown", await page.locator('[data-row="curator:for_you"] .is-rank-1 .stashboard-rank-crown').count() === 1);

    const cont = await rowInfo(page, "local:continue");
    const upNext = await page.evaluate(() => {
      const el = document.querySelector('[data-row="local:continue"]');
      return { watched: el.querySelectorAll(".stashboard-watched").length, left: [...el.querySelectorAll(".stashboard-upnext-left")].map((e) => e.textContent), label: !!el.querySelector(".stashboard-upnext-label") };
    });
    check("Up next: the half-watched scene with ✓ and ✕, then what's new", cont.title === "Up next" && /Fictional Scene 03/.test(cont.scenes[0].title) &&
      upNext.watched === 1 && JSON.stringify(upNext.left) === JSON.stringify(["Started"]) && upNext.label && cont.scenes.length === 4, { cont, upNext });

    const jane = (await gql(base, "{ findPerformers(filter: { q: \"Jane Doe\" }) { performers { id } } }")).findPerformers.performers[0].id;
    const janeUnwatched = (await gql(base, "query($id: ID!) { findScenes(scene_filter: { performers: { value: [$id], modifier: INCLUDES }, play_count: { value: 0, modifier: EQUALS } }) { count } }", { id: jane })).findScenes.count;
    const bubble = await page.evaluate((id) => {
      const b = document.querySelector(`[data-row="bubbles"] [data-performer="${id}"]`);
      return b && { count: (b.querySelector(".stashboard-bubble-count") || {}).textContent, href: b.getAttribute("href") };
    }, jane);
    check("your performers: Jane, a favourite, with her unwatched scenes counted", bubble && bubble.count === String(janeUnwatched) && bubble.href === `/performers/${jane}`, { bubble, janeUnwatched });
    const libraryTop = await page.evaluate(() => Math.round(document.querySelector('[data-row="curator:for_you"]').getBoundingClientRect().top));
    await page.click(`[data-row="bubbles"] [data-performer="${jane}"]`);
    await page.waitForSelector(`.stashboard-performer-panel[data-panel="${jane}"] .stashboard-scene`, { timeout: 10000 });
    const panel = await page.evaluate(() => ({
      url: location.pathname + location.search,
      scenes: document.querySelectorAll(".stashboard-performer-panel .stashboard-scene").length,
      head: document.querySelector(".stashboard-performer-panel-head strong").textContent,
      below: Math.round(document.querySelector('[data-row="curator:for_you"]').getBoundingClientRect().top + window.scrollY)
    }));
    check("clicking her opens her unwatched scenes below the faces and pushes the page down",
      panel.url === "/" && panel.scenes === Math.min(12, janeUnwatched) && panel.head === `Jane Doe: ${janeUnwatched} unwatched` && panel.below > libraryTop + 100, { panel, libraryTop });
    await page.click(".stashboard-panel-close");
    check("…and ✕ closes them again", await page.locator(".stashboard-performer-panel").count() === 0);

    const forYou = await rowInfo(page, "curator:for_you");
    check("top 5 keeps Curator's order", JSON.stringify(forYou.scenes.map((s) => s.title.match(/\d+/)[0])) === JSON.stringify(["30", "29", "28", "05", "11"]), forYou.scenes);
    const rediscover = await rowInfo(page, "local:rediscover");
    check("not watched in a while: one of the four played 200 days ago, as a question",
      rediscover.scenes.length === 1 && /Scene (04|08|12|16)$/.test(rediscover.scenes[0].title) && rediscover.title === "Watched 200 days ago", rediscover);
    const tag = await rowInfo(page, "local:tag_of_the_day");
    const chips = await page.locator('[data-row="local:tag_of_the_day"] .stashboard-chip:not(.stashboard-tag-roll)').allTextContents();
    check("tag of the day names the tag, shows three scenes and the other tags", /^Tag of the day: (Outdoor|Romantic|Classic)$/.test(tag.title) && tag.scenes.length === 3 && chips.length === 3, { title: tag.title, chips });
    const otherTag = chips.find((c) => !tag.title.endsWith(c));
    await page.click(`[data-row="local:tag_of_the_day"] .stashboard-chip:text-is("${otherTag}")`);
    await page.waitForFunction((name) => document.querySelector('[data-row="local:tag_of_the_day"] h2').textContent.endsWith(name), otherTag, { timeout: 10000 });
    check("a tag chip switches the tile to that tag", true);
    const studio = await page.evaluate(() => {
      const el = document.querySelector('[data-row="local:studio_spotlight"]');
      return { name: el.querySelector(".stashboard-studio-name").textContent, scenes: el.querySelectorAll(".stashboard-scene").length, counts: el.querySelector(".stashboard-studio .stashboard-scene-meta").textContent };
    });
    check("studio spotlight: the studio, its counts and three scenes", /^(Acme Studio|Beta Films)$/.test(studio.name) && studio.scenes === 3 && /\d+ scenes · \d+ unwatched/.test(studio.counts), studio);
    const surprise = await page.locator('[data-row="local:random"] .stashboard-surprise-go').getAttribute("href");
    const surpriseId = (surprise.match(/\/scenes\/(\d+)\?autoplay=true$/) || [])[1];
    const surpriseScene = surpriseId && (await gql(base, "query($id: ID!) { findScene(id: $id) { play_count resume_time } }", { id: surpriseId })).findScene;
    check("surprise me plays a scene you haven't started", surpriseScene && surpriseScene.play_count === 0 && !surpriseScene.resume_time, { surprise, surpriseScene });

    const nativeRows = await page.locator(".stashboard-native .recommendation-row").count();
    check("Stash's own front page rows stay below", nativeRows > 0, nativeRows);
    if (shots) {
      // Without Stash's fixed navbar over the top of it.
      await page.addStyleTag({ content: ".navbar { visibility: hidden !important; }" });
      await page.locator(".stashboard").screenshot({ path: path.join(shots, "dashboard.png") });
      await page.addStyleTag({ content: ".navbar { visibility: visible !important; }" });
    }

    console.log("Discover");
    await page.click(".stashboard-teaser");
    await page.waitForSelector('.stashboard-tab.is-on[data-tab="discover"]', { timeout: 10000 });
    await settle(page);
    check("the teaser opens the Discover tab, with its own address", await page.evaluate(() => location.search) === "?stashboard=discover");
    const discoverRows = await rowsOnPage(page);
    check("Discover has Curator's Find and the StashDB modules, nothing from the library", JSON.stringify(discoverRows) === JSON.stringify([
      "discover:pick", "discover:faces", "discover:matches", "discover:like", "discover:fresh", "discover:hunt", "box:stashdb.org:trending", "box:stashdb.org:favorites"
    ]), discoverRows);
    check("…and no Stash rows under it", await page.locator(".stashboard-native").count() === 0);
    const discoverLines = await page.evaluate(() => {
      const top = (id) => Math.round(document.querySelector(`[data-row="${id}"]`).getBoundingClientRect().top);
      return { pick: top("discover:pick"), faces: top("discover:faces"), like: top("discover:like"), fresh: top("discover:fresh"), trending: top("box:stashdb.org:trending"), favourites: top("box:stashdb.org:favorites") };
    });
    check("Discover's modules share lines too", discoverLines.pick === discoverLines.faces && discoverLines.like === discoverLines.fresh && discoverLines.trending === discoverLines.favourites, discoverLines);

    const pickTitle = () => page.locator('[data-row="discover:pick"] .stashboard-pick-title').textContent();
    const pick = await page.evaluate(() => {
      const el = document.querySelector('[data-row="discover:pick"]');
      return { title: el.querySelector(".stashboard-pick-title").textContent, why: [...el.querySelectorAll(".stashboard-pick-why li")].map((li) => li.textContent), href: el.querySelector(".stashboard-pick-title").getAttribute("href") };
    });
    check("find of the day: one of Curator's StashDB matches, with why it fits", /^Match \d+$/.test(pick.title) && pick.why.includes("Studio you like") && /^https:\/\/stashdb\.org\/scenes\/x\d+$/.test(pick.href), pick);
    await page.click(".stashboard-pick-next");
    check("…↻ goes on to the next find", (await pickTitle()) !== pick.title, await pickTitle());

    const matches = await rowInfo(page, "discover:matches");
    check("made for you: eight of Curator's matches, best first, without what's in the library or found there",
      matches.external.length === 8 && JSON.stringify(matches.external.slice(0, 3).map((c) => c.title)) === JSON.stringify(["Match 01", "Match 02", "Match 04"]), matches.external.map((c) => c.title));
    const moreLabel = await page.locator('[data-row="discover:matches"] .stashboard-more').textContent();
    await page.click('[data-row="discover:matches"] .stashboard-more');
    check("…More shows many more", (await rowInfo(page, "discover:matches")).external.length === 30 && /More \(22\)/.test(moreLabel), moreLabel);
    await page.click('[data-row="discover:matches"] .stashboard-ext-card >> nth=0 >> .stashboard-dismiss');
    await page.waitForFunction(() => document.querySelector('[data-row="discover:matches"] .stashboard-ext-title').textContent === "Match 02", null, { timeout: 10000 });
    check("✕ takes a card away and tells Curator: not interested", readCuratorState().dismissed.includes("x1"), readCuratorState());
    await page.click('[data-row="discover:matches"] .stashboard-ext-card >> nth=0 >> .stashboard-shortlist');
    await page.waitForSelector('[data-row="discover:shortlist"] .stashboard-ext-card', { timeout: 15000 });
    check("📌 keeps a card on the shortlist, which shows up in Discover",
      readCuratorState().shortlist.includes("x2") && JSON.stringify((await rowInfo(page, "discover:shortlist")).external.map((c) => c.title)) === JSON.stringify(["Match 02"]) &&
      await page.locator('[data-row="discover:matches"] .stashboard-shortlist.is-on').count() === 1);
    await page.click('[data-row="discover:shortlist"] .stashboard-shortlist');
    await page.waitForSelector('.stashboard-module[data-row="discover:shortlist"]', { state: "detached", timeout: 15000 });
    check("…and 📌 again takes it off", !readCuratorState().shortlist.includes("x2"));
    await page.click('[data-row="discover:matches"] .stashboard-reroll');
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-row="discover:matches"] .stashboard-ext-title');
      return t && t.textContent !== "Match 02";
    }, null, { timeout: 15000 });
    check("…🎲 shows other matches", /^Match \d+$/.test((await rowInfo(page, "discover:matches")).external[0].title));

    const fresh = await rowInfo(page, "discover:fresh");
    check("just released: newest first, with the day they came out", fresh.external.length === 5 && fresh.external[0].title === "Fresh 1" &&
      /\d/.test(await page.locator('[data-row="discover:fresh"] .stashboard-chart-rank >> nth=0').textContent()), fresh.external.map((c) => c.title));
    const like = await rowInfo(page, "discover:like");
    const likeParts = await page.evaluate(() => ({
      library: [...document.querySelectorAll('[data-row="discover:like"] [data-part="library"] .stashboard-scene-title')].map((e) => e.textContent),
      stashdb: [...document.querySelectorAll('[data-row="discover:like"] [data-part="stashdb"] .stashboard-ext-title')].map((e) => e.textContent)
    }));
    check("more like a scene you watched: similar ones in the library and on StashDB",
      /^More like “Fictional Scene (04|08|12|16|20)”$/.test(like.title) && JSON.stringify(likeParts.library) === JSON.stringify(["Fictional Scene 09", "Fictional Scene 10", "Fictional Scene 13"]) &&
      JSON.stringify(likeParts.stashdb) === JSON.stringify(["Match 05", "Match 06"]), { title: like.title, likeParts });

    const huntTitles = () => page.evaluate(() => [...document.querySelectorAll('[data-row="discover:hunt"] .stashboard-ext-title')].map((e) => e.textContent));
    check("Performer Hunt starts with one of your performers on StashDB",
      await page.locator('[data-row="discover:hunt"] .stashboard-hunt-target.is-on[data-target="sdb-perf-jane"]').count() === 1 &&
      JSON.stringify(await huntTitles()) === JSON.stringify(["Jane Hunt 1", "Jane Hunt 2", "Jane Hunt 3", "Jane Hunt 4", "Jane Hunt 5"]), await huntTitles());
    const faces = await page.evaluate(() => [...document.querySelectorAll('[data-row="discover:faces"] .stashboard-face')].map((f) => f.querySelector(".stashboard-face-name").textContent));
    check("new faces: six performers Curator found on StashDB", faces.length === 6 && faces[0] === "Face 1", faces);
    await page.click('[data-row="discover:faces"] [data-face="fp1"] .stashboard-face-hunt');
    await page.waitForSelector('[data-row="discover:hunt"] .stashboard-hunt-target.is-on[data-target="fp1"]', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-row="discover:hunt"] .stashboard-ext-title').length === 3, null, { timeout: 20000 });
    await sleep(800);
    const huntTop = await page.evaluate(() => Math.round(document.querySelector('[data-row="discover:hunt"]').getBoundingClientRect().top));
    check("…🏹 hunts one of them, and goes there", JSON.stringify(await huntTitles()) === JSON.stringify(["Face Hunt 1", "Face Hunt 2", "Face Hunt 3"]) && huntTop >= 0 && huntTop < 300, { huntTop, titles: await huntTitles() });
    await page.fill('[data-row="discover:hunt"] .stashboard-hunt-search input', "Searched");
    await page.waitForSelector(".stashboard-hunt-found button", { timeout: 10000 });
    await page.click('[data-row="discover:hunt"] .stashboard-hunt-target[data-target="sdb-perf-jane"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-row="discover:hunt"] .stashboard-ext-title').length === 5, null, { timeout: 20000 });
    check("searching StashDB finds anyone to hunt for", await page.locator(".stashboard-hunt-found").count() === 0);
    await page.fill('[data-row="discover:hunt"] .stashboard-hunt-search input', "Searched");
    await page.click(".stashboard-hunt-found button >> nth=0");
    await page.waitForFunction(() => document.querySelectorAll('[data-row="discover:hunt"] .stashboard-ext-title').length === 3, null, { timeout: 20000 });
    check("…and picking one hunts them", await page.locator('[data-row="discover:hunt"] .stashboard-hunt-target.is-on[data-target="fp1"]').count() === 1);

    const trending = await rowInfo(page, "box:stashdb.org:trending");
    check("trending on StashDB: a chart of five", trending.external.length === 5 && await page.locator('[data-row="box:stashdb.org:trending"] .stashboard-chart-rank').count() === 5, trending.external.length);
    check("scenes already in the library are marked and link to the local scene",
      trending.external[0].owned && trending.external[0].href === "/scenes/1" && trending.external[3].owned && trending.external[3].href === "/scenes/2" && /In your library/.test(trending.external[0].badge),
      trending.external.slice(0, 4));
    check("other StashDB scenes link to StashDB", !trending.external[1].owned && trending.external[1].href === "https://stashdb.org/scenes/t2", trending.external[1]);
    const favs = await rowInfo(page, "box:stashdb.org:favorites");
    check("favourites: four cards, sdb-scene-3 marked", favs.external.length === 4 && favs.external.some((c) => c.owned && c.href === "/scenes/3"), favs.external);

    check("every StashDB request carries the API key", boxRequests.length > 0 && boxRequests.every((r) => r.apiKey === API_KEY), boxRequests.map((r) => r.apiKey));
    check("StashDB is asked once per module, not per card", boxRequests.length === 2, boxRequests.map((r) => r.kind));
    const favReq = boxRequests.find((r) => r.kind === "favorites");
    check("favourites ask for released scenes only", favReq && favReq.input.favorites === "ALL" && favReq.input.date && favReq.input.date.modifier === "LESS_THAN", favReq);

    if (shots) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.addStyleTag({ content: ".navbar { visibility: hidden !important; }" });
      await page.locator('[data-zone="discover"]').screenshot({ path: path.join(shots, "discover-tab.png") });
      await page.addStyleTag({ content: ".navbar { visibility: visible !important; }" });
    }

    console.log("stasharr");
    check("without stasharr there are no download buttons", await page.locator(".stashboard-download").count() === 0);
    // What stasharr's stash-marker.js does on the Stash page, after the dashboard has rendered.
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-stasharr", "1.6.0");
      window.dispatchEvent(new CustomEvent("stasharr:ready"));
    });
    await page.waitForSelector(".stashboard-download", { timeout: 10000 });
    const downloads = await page.evaluate(() => [...document.querySelectorAll('[data-row="box:stashdb.org:trending"] .stashboard-ext-card')].map((c) => {
      const a = c.querySelector(".stashboard-download");
      return { owned: c.classList.contains("is-owned"), href: a && a.getAttribute("href"), target: a && a.getAttribute("target") };
    }));
    check("with stasharr every StashDB scene you don't have gets a download button",
      downloads.filter((d) => !d.owned).every((d) => /^https:\/\/stashdb\.org\/scenes\/[^#]+#stasharr-search$/.test(d.href) && d.target === "_blank") &&
      downloads.filter((d) => d.owned).every((d) => d.href === null) && downloads.filter((d) => d.href).length === 3, downloads);
    const [tab] = await Promise.all([context.waitForEvent("page"), page.click('[data-row="box:stashdb.org:trending"] .stashboard-download >> nth=0')]);
    await tab.waitForLoadState("domcontentloaded").catch(() => {});
    check("Download opens the scene on StashDB with stasharr's search hash", tab.url() === "https://stashdb.org/scenes/t2#stasharr-search", tab.url());
    await tab.close();
    if (shots) {
      await page.locator('[data-row="box:stashdb.org:trending"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(shots, "stashdb-rows.png") });
    }

    console.log("Cache and Refresh");
    const before = boxRequests.length;
    await openDiscover(page, base);
    check("StashDB rows come from the cache on the next visit", boxRequests.length === before, { before, after: boxRequests.length });
    await page.click(".stashboard-refresh");
    await settle(page);
    check("Refresh asks StashDB again", boxRequests.length > before, { before, after: boxRequests.length });

    console.log("New mix");
    await openDashboard(page, base);
    const surpriseNow = () => page.locator('[data-row="local:random"] .stashboard-surprise-go').getAttribute("href");
    const surpriseBefore = await surpriseNow();
    const boxBefore = boxRequests.length;
    let surpriseAfter = surpriseBefore;
    for (let i = 0; i < 4 && surpriseAfter === surpriseBefore; i++) {
      await page.click(".stashboard-mix");
      await settle(page);
      surpriseAfter = await surpriseNow();
    }
    check("New mix draws the random modules again", surpriseBefore !== surpriseAfter, { surpriseBefore, surpriseAfter });
    check("New mix doesn't ask StashDB again", boxRequests.length === boxBefore, { before: boxBefore, after: boxRequests.length });

    console.log("Customise");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click(".stashboard-customise-open");
    await page.waitForSelector(".stashboard-customise-list li");
    check("the customise dialog shows the Required Notices",
      await page.locator(".stashboard-customise .stashboard-notice").filter({ hasText: "This software is vibecoded." }).count() === 1);
    await page.click('.stashboard-customise-list li[data-row="local:random"] label');
    await page.click('.stashboard-customise-list li[data-row="box:stashdb.org:performers"] label');
    check("the dialog groups the modules by zone", await page.locator('.stashboard-customise-list[data-zone="discover"] li[data-row="box:stashdb.org:trending"]').count() === 1 &&
      await page.locator('.stashboard-customise-list[data-zone="discover"] li[data-row="discover:hunt"]').count() === 1 &&
      await page.locator('.stashboard-customise-list[data-zone="library"] li[data-row="box:stashdb.org:trending"]').count() === 0);
    // Past the top 5, your performers and Up next, to right after the spotlight.
    for (let i = 0; i < 4; i++) await page.click('.stashboard-customise-list li[data-row="local:studio_spotlight"] button[aria-label="Move up"]');
    await page.click(".stashboard-save");
    await page.waitForSelector(".stashboard-customise", { state: "detached" });
    const saved = await pluginSettings(base);
    check("Save stores the layout in Stash's plugin settings", typeof saved.modules === "string" && saved.modules.includes("local:random"), saved);
    const asked = boxRequests.length;
    await openDashboard(page, base);
    const customised = await rowsOnPage(page);
    await openDiscover(page, base);
    const customisedDiscover = await rowsOnPage(page);
    check("the saved layout applies: module moved up, one switched off, one switched on",
      customised[1] === "local:studio_spotlight" && !customised.includes("local:random") && customisedDiscover.includes("box:stashdb.org:performers"), { customised, customisedDiscover });
    const perfReq = boxRequests.slice(asked).find((r) => r.kind === "performers");
    check("new with your performers follows the library's performers, favourite first",
      perfReq && JSON.stringify(perfReq.input.performers) === JSON.stringify({ value: ["sdb-perf-jane", "sdb-perf-mary"], modifier: "INCLUDES" }), perfReq && perfReq.input.performers);

    console.log("Remove from Continue watching");
    // A second scene in progress, with the play Stash records when playback starts.
    const started = (await gql(base, "{ findScenes(filter: { q: \"Fictional Scene 10\" }) { scenes { id play_count } } }")).findScenes.scenes[0];
    await gql(base, "mutation($id: ID!) { sceneAddPlay(id: $id) { count } }", { id: started.id });
    await gql(base, "mutation($id: ID!) { sceneSaveActivity(id: $id, resume_time: 120, playDuration: 60) }", { id: started.id });
    await openDashboard(page, base);
    const card = (sceneId) => page.locator(`[data-row="local:continue"] [data-scene="${sceneId}"]`);
    check("each scene to continue has ✓ and ✕", await page.locator('[data-row="local:continue"] .stashboard-watched').count() === 2 &&
      await page.locator('[data-row="local:continue"] .stashboard-remove').count() === 2);
    check("what's new under it doesn't", await page.locator(".stashboard-watched").count() === 2);
    await card(started.id).locator(".stashboard-remove").click();
    await card(started.id).waitFor({ state: "detached", timeout: 10000 });
    const removed = (await gql(base, "query($id: ID!) { findScene(id: $id) { resume_time play_count } }", { id: started.id })).findScene;
    check("Remove deletes the unfinished viewing: no position, its play gone", removed.resume_time === 0 && removed.play_count === started.play_count, removed);

    console.log("Mark as watched");
    const resumed = (await gql(base, "{ findScenes(scene_filter: { resume_time: { value: 0, modifier: GREATER_THAN } }) { scenes { id play_count } } }")).findScenes.scenes;
    check("one scene left to continue", resumed.length === 1 && await page.locator('[data-row="local:continue"] .stashboard-watched').count() === 1, resumed);
    await page.click('[data-row="local:continue"] .stashboard-watched');
    await page.waitForSelector('[data-row="local:continue"] .stashboard-watched', { state: "detached", timeout: 10000 });
    const after = (await gql(base, "query($id: ID!) { findScene(id: $id) { resume_time play_count } }", { id: resumed[0].id })).findScene;
    check("Watched forgets the position and counts a play; the scene goes", after.resume_time === 0 && after.play_count === resumed[0].play_count + 1 &&
      await page.locator(`[data-row="local:continue"] [data-scene="${resumed[0].id}"]`).count() === 0, after);
    await openDashboard(page, base);
    check("…and stays gone after a reload, leaving what's new", await page.locator('[data-row="local:continue"] .stashboard-watched').count() === 0 &&
      (await rowInfo(page, "local:continue")).scenes.length === 4);

    console.log("Radar");
    const performer = async (id) => (await gql(base, "query($id: ID!) { findPerformer(id: $id) { favorite custom_fields } }", { id })).findPerformer;
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    await page.goto(`${base}/scenes/1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".performer-card", { timeout: 30000 });
    await sleep(500);
    check("no 📡 for a favourite (Jane)", await page.locator(".stashboard-radar-card").count() === 0);
    await page.goto(`${base}/scenes/2`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".performer-card .stashboard-radar-card", { timeout: 30000 });
    await page.locator(".performer-card").first().hover();
    await page.click(".performer-card .stashboard-radar-card");
    await page.waitForSelector(".performer-card .stashboard-radar-card.is-on", { timeout: 10000 });
    check("📡 on a performer card puts Mary on the radar, dated today", (await performer("2")).custom_fields.radar === today, await performer("2"));
    check("…and says so", /Mary Major is on your radar/.test(await page.locator(".toast-container").innerText().catch(() => "")));

    // Rita: linked to StashDB, no scenes here, no Curator hunt → StashDB's popularity.
    await gql(base, "mutation($input: PerformerCreateInput!) { performerCreate(input: $input) { id } }", { input: {
      name: "Rita Radar", gender: "FEMALE",
      stash_ids: [{ endpoint: STASHDB, stash_id: "sdb-perf-rita" }],
      custom_fields: { radar: "2026-01-01" }
    } });
    const ritaId = (await gql(base, "{ findPerformers(filter: { q: \"Rita Radar\" }) { performers { id } } }")).findPerformers.performers[0].id;
    const radarShown = () => page.evaluate(() => [...document.querySelectorAll(".stashboard-radar-row")].map((r) => r.getAttribute("data-row")));
    const radarAfter = async (lastId) => {
      await page.evaluate((id) => localStorage.setItem("stashboard:radar-last", id), lastId);
      await openDiscover(page, base);
      return radarShown();
    };
    const radarRow = (id) => page.evaluate((rowId) => {
      const el = document.querySelector(`[data-row="${rowId}"]`);
      return el && {
        title: el.querySelector(".stashboard-radar-name").textContent.trim(),
        bar: el.querySelector(".stashboard-radar-bar").textContent,
        due: el.querySelector(".stashboard-radar-bar").classList.contains("is-due"),
        next: !!el.querySelector(".stashboard-radar-next"),
        inDiscover: !!el.closest('[data-zone="discover"]'),
        stats: [...el.querySelectorAll(".stashboard-radar-stats b")].map((b) => b.textContent),
        local: el.querySelectorAll(".stashboard-scene.is-local").length,
        external: [...el.querySelectorAll(".stashboard-ext-card .stashboard-ext-title")].map((t) => t.textContent.trim()),
        message: (el.querySelector(".stashboard-row-message") || {}).textContent || ""
      };
    }, id);
    let radarIds = await radarAfter(ritaId);
    check("one performer from the radar, not the one shown last", JSON.stringify(radarIds) === JSON.stringify(["radar:2"]), radarIds);
    const maryUnwatched = (await gql(base, "{ findScenes(scene_filter: { performers: { value: [\"2\"], modifier: INCLUDES }, play_count: { value: 0, modifier: EQUALS } }) { count } }")).findScenes.count;
    const mary = await radarRow("radar:2");
    check("Mary's profile: since today, her unwatched count, two of them from the library", mary.title === "Mary Major" && mary.local === Math.min(2, maryUnwatched) &&
      mary.stats[1] === String(maryUnwatched) && /since today/.test(mary.bar) && !mary.due, mary);
    check("…in Discover, with 🎲", mary.inDiscover && mary.next, mary);
    check("…then Curator's hunt for her, best match first, without what Curator found locally",
      JSON.stringify(mary.external) === JSON.stringify(["Hunt Two", "Hunt One"]), mary.external);
    await page.evaluate(() => { document.documentElement.setAttribute("data-stasharr", "1.7.0"); window.dispatchEvent(new CustomEvent("stasharr:ready")); });
    await page.waitForSelector('[data-row="radar:2"] .stashboard-download', { timeout: 10000 });
    check("with stasharr, the radar's StashDB scenes can be downloaded", await page.locator('[data-row="radar:2"] .stashboard-download').count() === 2);
    if (shots) {
      await page.locator('[data-row="radar:2"]').scrollIntoViewIfNeeded();
      await page.locator('[data-zone="discover"]').screenshot({ path: path.join(shots, "discover.png") });
    }

    await openDiscover(page, base);
    radarIds = await radarShown();
    check("the next visit shows someone else", JSON.stringify(radarIds) === JSON.stringify([`radar:${ritaId}`]), radarIds);
    const rita = await radarRow(`radar:${ritaId}`);
    check("without a hunt, StashDB's most popular, minus what's in the library", JSON.stringify(rita.external) === JSON.stringify(["StashDB Scene r1", "StashDB Scene r2", "StashDB Scene r4"]) && rita.local === 0, rita);
    check("…and the decision is due after 30 days", rita.due && /A favourite\?/.test(rita.bar), rita.bar);
    const radarReq = boxRequests.find((r) => r.kind === "radar");
    check("the StashDB part asks for her released scenes by popularity", radarReq && radarReq.input.sort === "POPULARITY" &&
      JSON.stringify(radarReq.input.performers) === JSON.stringify({ value: ["sdb-perf-rita"], modifier: "INCLUDES" }) && radarReq.input.date.modifier === "LESS_THAN", radarReq);
    await page.click(".stashboard-radar-next");
    await page.waitForSelector('[data-row="radar:2"]', { timeout: 10000 });
    check("🎲 switches to another performer on the radar", JSON.stringify(await radarShown()) === JSON.stringify(["radar:2"]));

    // Three of Mary's scenes watched since she went on the radar → the question comes early.
    const maryScenes = (await gql(base, "{ findScenes(scene_filter: { performers: { value: [\"2\"], modifier: INCLUDES } }, filter: { per_page: 3 }) { scenes { id } } }")).findScenes.scenes;
    for (const s of maryScenes) await gql(base, "mutation($id: ID!) { sceneAddPlay(id: $id) { count } }", { id: s.id });
    await radarAfter(ritaId);
    check("three scenes watched since: the decision is due early", (await radarRow("radar:2")).due);
    await page.click('[data-row="radar:2"] .stashboard-radar-favourite');
    await page.waitForSelector('[data-row="radar:2"]', { state: "detached", timeout: 10000 });
    const maryNow = await performer("2");
    check("★ Favourite makes Mary a favourite and takes her off the radar", maryNow.favorite === true && !("radar" in maryNow.custom_fields), maryNow);
    await page.waitForSelector(`[data-row="radar:${ritaId}"]`, { timeout: 10000 });
    check("…and the next one on the radar takes her place, without 🎲 when alone", !(await radarRow(`radar:${ritaId}`)).next);
    await page.click('.stashboard-radar-row .stashboard-radar-remove');
    await page.waitForSelector(".stashboard-radar-row", { state: "detached", timeout: 10000 });
    const ritaNow = (await gql(base, "{ findPerformers(filter: { q: \"Rita Radar\" }) { performers { favorite custom_fields } } }")).findPerformers.performers[0];
    check("✕ Off the radar removes just the radar field", ritaNow.favorite === false && !("radar" in ritaNow.custom_fields), ritaNow);

    await page.goto(`${base}/performers/3`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".stashboard-radar-button", { timeout: 30000 });
    await page.click(".stashboard-radar-button");
    await page.waitForSelector(".stashboard-radar-button.is-on", { timeout: 10000 });
    check("the performer page has the same switch", (await performer("3")).custom_fields.radar === today && /On your radar/.test(await page.locator(".stashboard-radar-button").innerText()));
    if (shots) await page.screenshot({ path: path.join(shots, "performer-radar.png") });
    await page.click(".stashboard-radar-button");
    await page.waitForSelector(".stashboard-radar-button:not(.is-on)", { timeout: 10000 });
    check("…and takes them off again", !("radar" in (await performer("3")).custom_fields));

    console.log("Tabs, a hunt from the start page, and Expand still building");
    await openDashboard(page, base);
    await page.click(`[data-row="bubbles"] [data-performer="${jane}"]`);
    await page.click(".stashboard-panel-hunt");
    await page.waitForSelector('[data-row="discover:hunt"] .stashboard-hunt-target.is-on[data-target="sdb-perf-jane"]', { timeout: 15000 });
    check("🏹 in a performer's panel hunts them in Discover", await page.evaluate(() => location.search) === "?stashboard=discover");
    await page.goBack();
    await page.waitForSelector('.stashboard-tab.is-on[data-tab="home"]', { timeout: 10000 });
    check("Back returns to the start page", await page.locator('[data-zone="library"]').count() === 1 && await page.locator('[data-zone="discover"]').count() === 0);
    fs.writeFileSync(curatorState, JSON.stringify({ ...readCuratorState(), ready: false }));
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("stashboard:")) localStorage.removeItem(k); });
    await openDiscover(page, base);
    const building = await rowsOnPage(page);
    check("while Curator builds its StashDB catalogue, Discover says so and leaves those modules out",
      await page.locator(".stashboard-expand-building").count() === 1 && !building.includes("discover:matches") && building.includes("discover:hunt"), building);
    await page.click(".stashboard-expand-build");
    await waitFor("the Expand refresh task", () => readCuratorState().ready, 30000);
    await openDiscover(page, base);
    check("…Build it now starts Curator's task, and then they're back", await page.locator(".stashboard-expand-building").count() === 0 && (await rowsOnPage(page)).includes("discover:matches"));

    console.log("Curator inside");
    const status = await gql(base, "mutation { runPluginOperation(plugin_id: \"stashboard\", args: { operation: \"get_status\" }) }");
    check("Curator's backend answers as part of Stashboard", status.runPluginOperation && typeof status.runPluginOperation.schema_version === "number", status);
    const ownData = path.join(findPluginDir(path.join(dir, "plugins"), "stashboard.yml"), "data", "curator.sqlite3");
    check("the old Curator's data is copied into Stashboard's", fs.existsSync(ownData) && /from the old Curator/.test(sqlite(ownData, "SELECT marker FROM stashboard_e2e;")), ownData);
    const curatorCalls = [];
    page.on("request", (req) => { if (/runPluginOperation/.test(req.postData() || "")) curatorCalls.push(req.postData()); });
    await page.goto(`${base}/plugins/stash-curator`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[class*="curator-"]', { timeout: 30000 });
    await sleep(1500);
    check("Curator's own page still works, and talks to Stashboard's backend",
      curatorCalls.length > 0 && curatorCalls.every((c) => /plugin_id: \\"stashboard\\"/.test(c)), curatorCalls.slice(0, 3));
    await page.goto(`${base}/scenes`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".scene-card", { timeout: 30000 });
    await page.click('.navbar a[href="/"]');
    await page.waitForSelector(".stashboard-toolbar", { timeout: 30000 });
    check("…and back on the dashboard from another page, the tab says so again", (await page.title()) === "Stashboard | Stash", await page.title());
    await gql(base, "mutation($m: BoolMap!) { setPluginsEnabled(enabledMap: $m) }", { m: { "stash-curator": false } });
    await openDashboard(page, base);
    check("once the separate Curator is off, the notice goes", await page.locator(".stashboard-notice-bar").count() === 0);

    console.log("Settings");
    await setPluginSettings(base, { hideNativeRows: true, hideOwned: true });
    await openDashboard(page, base);
    check("hideNativeRows hides Stash's own rows, without them flashing up first",
      await page.locator(".stashboard-native").count() === 0 && await page.evaluate(() => !window.__stashboardNative.seen));
    await openDiscover(page, base);
    const trendingHidden = await rowInfo(page, "box:stashdb.org:trending");
    check("hideOwned leaves owned scenes out", trendingHidden.external.length === 5 && trendingHidden.external.every((c) => !c.owned), trendingHidden.external.map((c) => c.title));
    await setPluginSettings(base, { disableExternal: true });
    await openDiscover(page, base);
    check("disableExternal drops the StashDB rows and Curator's Find; the radar's library part may stay",
      !(await rowsOnPage(page)).some((id) => /^(box|discover):/.test(id)) && await page.locator(".stashboard-teaser").count() === 0);
    await setPluginSettings(base, { disableExternal: false, hideOwned: false, hideNativeRows: false });

    console.log("German");
    await gql(base, "mutation { configureInterface(input: { language: \"de-DE\" }) { language } }");
    await openDashboard(page, base);
    const toolbar = await page.locator(".stashboard-toolbar").textContent();
    check("German texts when Stash is set to German", /Neu mischen/.test(toolbar) && /Anpassen/.test(toolbar) && /Start/.test(toolbar), toolbar);
    check("German module titles", (await rowInfo(page, "local:continue")).title.toLowerCase() === "als nächstes");
    if (shots) await page.screenshot({ path: path.join(shots, "dashboard-de.png") });
    await gql(base, "mutation { configureInterface(input: { language: \"en-US\" }) { language } }");

    console.log("Phone");
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    phone.on("pageerror", (e) => problems.push(`pageerror (phone): ${e.message}`));
    // Stash's own carousel arrows stick out by a few pixels on phones with or
    // without Stashboard; only Stashboard's own elements are checked here.
    const fits = () => phone.evaluate(() => {
      const view = window.innerWidth;
      const wide = [...document.querySelectorAll(".stashboard *")]
        .filter((el) => !el.closest(".stashboard-bubbles") && el.getBoundingClientRect().right > view + 0.5)
        .map((el) => el.className);
      // Within each zone (Discover's sit inside its frame), all as wide as each other.
      const stacked = [...document.querySelectorAll(".stashboard-grid")].every((grid) => {
        const widths = [...grid.querySelectorAll(":scope > .stashboard-module")].map((m) => Math.round(m.getBoundingClientRect().width));
        return widths.every((w) => w === widths[0]);
      });
      return { view, wide, stacked };
    });
    await openDashboard(phone, base);
    const fit = await fits();
    check("on a phone Stashboard fits the screen, one module under the other", !fit.wide.length && fit.stacked, fit);
    if (shots) await phone.screenshot({ path: path.join(shots, "phone.png") });
    await openDiscover(phone, base);
    const fitDiscover = await fits();
    check("…Discover too", !fitDiscover.wide.length && fitDiscover.stacked, fitDiscover);
    await phone.close();

    console.log("Failures");
    box.fail = (kind) => kind === "trending";
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("stashboard:")) localStorage.removeItem(k); });
    await openDiscover(page, base);
    const broken = await rowInfo(page, "box:stashdb.org:trending");
    check("a failing StashDB row says so; the others still load",
      /Couldn't load this row/.test(broken.message) && (await rowInfo(page, "box:stashdb.org:favorites")).external.length > 0, broken.message);
    box.fail = null;
    await gql(base, "mutation($input: ConfigGeneralInput!) { configureGeneral(input: $input) { stashBoxes { endpoint } } }",
      { input: { stashBoxes: [{ endpoint: STASHDB, api_key: "wrong-key", name: "StashDB" }] } });
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("stashboard:")) localStorage.removeItem(k); });
    await openDiscover(page, base);
    check("with a wrong API key the StashDB rows explain where to set it",
      /needs a valid API key/.test((await rowInfo(page, "box:stashdb.org:favorites")).message));

    console.log("Switching off");
    await gql(base, "mutation { setPluginsEnabled(enabledMap: { stashboard: false }) }");
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".recommendation-row", { timeout: 30000 });
    check("disabled, the front page is Stash's own again", await page.locator(".stashboard").count() === 0);

    check("no errors in the browser console", problems.length === 0, problems);
  } finally {
    if (browser) await browser.close();
    server.close();
    proc.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed against Stash ${version}`);
  if (failed.length) {
    console.log(`Stash log: ${path.join(dir, "stash.log")}`);
    process.exit(1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
