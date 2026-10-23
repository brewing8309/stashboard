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

// Brings every lazy row near the screen once, then lets them load.
async function settle(page) {
  await page.waitForSelector(".stashboard-toolbar", { timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 900);
    await sleep(150);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector(".stashboard-skeleton, .stashboard-spotlight-loading"), null, { timeout: 30000 });
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
    return {
      title: title ? title.textContent.trim() : "",
      message: (el.querySelector(".stashboard-row-message") || {}).textContent || "",
      scenes: [...el.querySelectorAll(".scene-card")].map((c) => {
        const a = c.querySelector("a[href*='/scenes/']");
        return { title: (c.querySelector(".card-section-title, .TruncatedText, h5") || c).textContent.trim(), href: a ? a.getAttribute("href") : "" };
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

    fs.cpSync(path.join(__dirname, "fake-curator"), path.join(dir, "plugins", "stash-curator"), { recursive: true });
    await gql(base, "mutation { reloadPlugins }");
    await gql(base, "mutation($p: Map) { configureUI(partial: $p) }", { p: { lastNoteSeen: 99999999 } });
    await gql(base, "mutation($input: ConfigGeneralInput!) { configureGeneral(input: $input) { stashBoxes { endpoint } } }",
      { input: { stashBoxes: [{ endpoint: STASHDB, api_key: API_KEY, name: "StashDB" }] } });
    await seed(base);

    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "en-US" });
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
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`console.error: ${m.text()}`);
    });

    console.log("Dashboard");
    await openDashboard(page, base);
    const rows = await rowsOnPage(page);
    check("default rows, in order", JSON.stringify(rows.slice(0, 8)) === JSON.stringify([
      "spotlight", "local:continue", "curator:for_you", "local:recently_added",
      "box:stashdb.org:favorites", "box:stashdb.org:trending", "local:unwatched_favorites", "curator:best_bets"
    ]), rows);
    check("all default rows with content are shown",
      ["local:tag_of_the_day", "box:stashdb.org:performers", "local:rediscover", "local:studio_spotlight", "curator:revisit", "local:top_rated", "local:random"].every((id) => rows.includes(id)), rows);

    const spotlight = await page.evaluate(() => {
      const s = document.querySelector(".stashboard-spotlight");
      return s && { reason: s.querySelector(".stashboard-spotlight-reason").textContent, title: s.querySelector(".stashboard-spotlight-title").textContent, play: s.querySelector(".btn-primary").getAttribute("href") };
    });
    check("spotlight shows Curator's best bet with a Play link", spotlight && spotlight.reason === "Curator's best bet" && spotlight.title === "Fictional Scene 07" && /\/scenes\/7\?autoplay=true$/.test(spotlight.play), spotlight);

    const cont = await rowInfo(page, "local:continue");
    check("continue watching: the half-watched scene", cont.scenes.length === 1 && /Fictional Scene 03/.test(cont.scenes[0].title), cont);
    const forYou = await rowInfo(page, "curator:for_you");
    check("Curator row keeps Curator's order", JSON.stringify(forYou.scenes.map((s) => s.title.match(/\d+/)[0])) === JSON.stringify(["30", "29", "28", "05", "11"]), forYou.scenes);
    const recent = await rowInfo(page, "local:recently_added");
    const viewAll = await page.locator('[data-row="local:recently_added"] .stashboard-view-all').getAttribute("href");
    check("recently added: 12 native scene cards and a View all link", recent.scenes.length === 12 && /sortby=created_at/.test(viewAll || ""), { cards: recent.scenes.length, viewAll });
    const rediscover = await rowInfo(page, "local:rediscover");
    check("not watched in a while: the four played 200 days ago", rediscover.scenes.length === 4, rediscover.scenes);
    const tag = await rowInfo(page, "local:tag_of_the_day");
    check("tag of the day names the tag", /^Tag of the day: (Outdoor|Romantic|Classic)$/.test(tag.title) && tag.scenes.length === 10, tag.title);
    const unwatched = await rowInfo(page, "local:unwatched_favorites");
    check("unwatched with favourites: Jane's scenes, none played or started, capped at 12",
      unwatched.scenes.length === 12 && !unwatched.scenes.some((s) => /Scene 03$/.test(s.title)), unwatched.scenes.map((s) => s.title));

    const trending = await rowInfo(page, "box:stashdb.org:trending");
    check("trending on StashDB: 12 cards", trending.external.length === 12, trending.external.length);
    check("scenes already in the library are marked and link to the local scene",
      trending.external[0].owned && trending.external[0].href === "/scenes/1" && trending.external[3].owned && trending.external[3].href === "/scenes/2" && /In your library/.test(trending.external[0].badge),
      trending.external.slice(0, 4));
    check("other StashDB scenes link to StashDB", !trending.external[1].owned && trending.external[1].href === "https://stashdb.org/scenes/t2", trending.external[1]);
    const favs = await rowInfo(page, "box:stashdb.org:favorites");
    check("favourites row marks sdb-scene-3", favs.external.some((c) => c.owned && c.href === "/scenes/3"), favs.external);

    check("every StashDB request carries the API key", boxRequests.length > 0 && boxRequests.every((r) => r.apiKey === API_KEY), boxRequests.map((r) => r.apiKey));
    check("StashDB is asked once per row, not per card", boxRequests.length === 3, boxRequests.map((r) => r.kind));
    const favReq = boxRequests.find((r) => r.kind === "favorites");
    check("favourites ask for released scenes only", favReq && favReq.input.favorites === "ALL" && favReq.input.date && favReq.input.date.modifier === "LESS_THAN", favReq);
    const perfReq = boxRequests.find((r) => r.kind === "performers");
    check("performers row follows the library's performers, favourite first",
      perfReq && JSON.stringify(perfReq.input.performers) === JSON.stringify({ value: ["sdb-perf-jane", "sdb-perf-mary"], modifier: "INCLUDES" }), perfReq && perfReq.input.performers);

    const nativeRows = await page.locator(".stashboard-native .recommendation-row").count();
    check("Stash's own front page rows stay below", nativeRows > 0, nativeRows);
    if (shots) await page.screenshot({ path: path.join(shots, "dashboard.png") });

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
      downloads.filter((d) => d.owned).every((d) => d.href === null) && downloads.filter((d) => d.href).length === 10, downloads);
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
    await openDashboard(page, base);
    check("StashDB rows come from the cache on the next visit", boxRequests.length === before, { before, after: boxRequests.length });
    await page.click(".stashboard-refresh");
    await settle(page);
    check("Refresh asks StashDB again", boxRequests.length > before, { before, after: boxRequests.length });

    console.log("New mix");
    const randomBefore = JSON.stringify((await rowInfo(page, "local:random")).scenes.map((s) => s.title));
    const boxBefore = boxRequests.length;
    await page.click(".stashboard-mix");
    await settle(page);
    const randomAfter = JSON.stringify((await rowInfo(page, "local:random")).scenes.map((s) => s.title));
    check("New mix draws the random rows again", randomBefore !== randomAfter);
    check("New mix doesn't ask StashDB again", boxRequests.length === boxBefore, { before: boxBefore, after: boxRequests.length });

    console.log("Customise");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click(".stashboard-customise-open");
    await page.waitForSelector(".stashboard-customise-list li");
    check("the customise dialog shows the Required Notices",
      await page.locator(".stashboard-customise .stashboard-notice").filter({ hasText: "This software is vibecoded." }).count() === 1);
    await page.click('.stashboard-customise-list li[data-row="local:random"] label');
    await page.click('.stashboard-customise-list li[data-row="local:recently_added"] button[aria-label="Move up"]');
    await page.click('.stashboard-customise-list li[data-row="local:recently_added"] button[aria-label="Move up"]');
    await page.click(".stashboard-save");
    await page.waitForSelector(".stashboard-customise", { state: "detached" });
    const saved = await pluginSettings(base);
    check("Save stores the layout in Stash's plugin settings", typeof saved.layout === "string" && saved.layout.includes("local:random"), saved);
    await openDashboard(page, base);
    const customised = await rowsOnPage(page);
    check("the saved layout applies: row moved up, row switched off",
      customised[1] === "local:recently_added" && !customised.includes("local:random"), customised.slice(0, 4));

    console.log("Settings");
    await setPluginSettings(base, { hideNativeRows: true, hideOwned: true, itemsPerRow: 6 });
    await openDashboard(page, base);
    check("hideNativeRows hides Stash's own rows", await page.locator(".stashboard-native").count() === 0);
    const trendingHidden = await rowInfo(page, "box:stashdb.org:trending");
    check("hideOwned leaves owned scenes out", trendingHidden.external.length === 6 && trendingHidden.external.every((c) => !c.owned), trendingHidden.external.map((c) => c.title));
    check("itemsPerRow applies to local rows", (await rowInfo(page, "local:unwatched_favorites")).scenes.length === 6);
    await setPluginSettings(base, { disableExternal: true });
    await openDashboard(page, base);
    check("disableExternal drops the StashDB rows", !(await rowsOnPage(page)).some((id) => id.startsWith("box:")));
    await setPluginSettings(base, { disableExternal: false, hideOwned: false, hideNativeRows: false, itemsPerRow: 12 });

    console.log("German");
    await gql(base, "mutation { configureInterface(input: { language: \"de-DE\" }) { language } }");
    await openDashboard(page, base);
    const toolbar = await page.locator(".stashboard-toolbar").textContent();
    check("German texts when Stash is set to German", /Neu mischen/.test(toolbar) && /Anpassen/.test(toolbar), toolbar);
    check("German row titles", (await rowInfo(page, "local:continue")).title.toLowerCase() === "weiterschauen");
    if (shots) await page.screenshot({ path: path.join(shots, "dashboard-de.png") });
    await gql(base, "mutation { configureInterface(input: { language: \"en-US\" }) { language } }");

    console.log("Phone");
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    phone.on("pageerror", (e) => problems.push(`pageerror (phone): ${e.message}`));
    await openDashboard(phone, base);
    // Stash's own carousel arrows stick out by a few pixels on phones with or
    // without Stashboard; only Stashboard's own elements are checked here.
    const fit = await phone.evaluate(() => {
      const view = window.innerWidth;
      const wide = [...document.querySelectorAll(".stashboard *")]
        .filter((el) => !el.closest(".stashboard-strip") && el.getBoundingClientRect().right > view + 0.5)
        .map((el) => el.className);
      const strip = document.querySelector('[data-row="local:recently_added"] .stashboard-strip');
      return { view, wide, stripScrolls: !!strip && strip.scrollWidth > strip.clientWidth };
    });
    check("on a phone Stashboard fits the screen and its rows scroll sideways", !fit.wide.length && fit.stripScrolls, fit);
    if (shots) await phone.screenshot({ path: path.join(shots, "phone.png") });
    await phone.close();

    console.log("Failures");
    box.fail = (kind) => kind === "trending";
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("stashboard:")) localStorage.removeItem(k); });
    await openDashboard(page, base);
    const broken = await rowInfo(page, "box:stashdb.org:trending");
    check("a failing StashDB row says so; the others still load",
      /Couldn't load this row/.test(broken.message) && (await rowInfo(page, "box:stashdb.org:favorites")).external.length > 0, broken.message);
    box.fail = null;
    await gql(base, "mutation($input: ConfigGeneralInput!) { configureGeneral(input: $input) { stashBoxes { endpoint } } }",
      { input: { stashBoxes: [{ endpoint: STASHDB, api_key: "wrong-key", name: "StashDB" }] } });
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("stashboard:")) localStorage.removeItem(k); });
    await openDashboard(page, base);
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
