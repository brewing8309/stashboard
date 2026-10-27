const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../plugin/stashboard-core.js");

const STASHDB = { endpoint: "https://stashdb.org/graphql", api_key: "key", name: "StashDB" };
const box = c.boxFromConfig(STASHDB);
const env = (extra = {}) => ({ curator: false, boxes: [box], disableExternal: false, ...extra });

test("known stash-boxes are recognised by host, anything else is not", () => {
  assert.deepEqual(box, { host: "stashdb.org", name: "StashDB", endpoint: "https://stashdb.org/graphql", site: "https://stashdb.org", apiKey: "key" });
  assert.equal(c.boxFromConfig({ endpoint: "https://STASHDB.org/graphql", api_key: "" }).host, "stashdb.org");
  assert.equal(c.boxFromConfig({ endpoint: "http://stashdb.org/graphql" }), null, "plain http is not the real StashDB");
  assert.equal(c.boxFromConfig({ endpoint: "https://theporndb.net/graphql" }), null);
  assert.equal(c.boxFromConfig({ endpoint: "not a url" }), null);
  assert.equal(c.boxFromConfig(null), null);
});

test("usableBoxes keeps one box per host and names the unsupported ones", () => {
  const { boxes, unsupported } = c.usableBoxes([
    STASHDB,
    { endpoint: "https://stashdb.org/graphql", api_key: "other", name: "StashDB again" },
    { endpoint: "https://fansdb.cc/graphql", api_key: "k", name: "" },
    { endpoint: "https://theporndb.net/graphql", api_key: "k", name: "TPDB" }
  ]);
  assert.deepEqual(boxes.map((b) => [b.host, b.name, b.apiKey]), [["stashdb.org", "StashDB", "key"], ["fansdb.cc", "FansDB", "k"]]);
  assert.deepEqual(unsupported, ["TPDB"]);
});

test("the default layout turns on the default rows that are available", () => {
  const plain = c.defaultLayout(env({ boxes: [] }));
  assert.deepEqual(plain.filter((r) => r.on).map((r) => r.id), [
    "spotlight", "local:continue", "radar", "local:recently_added", "local:unwatched_favorites",
    "local:tag_of_the_day", "local:rediscover", "local:studio_spotlight", "local:top_rated", "local:random"
  ]);
  const full = c.defaultLayout(env({ curator: true }));
  const on = full.filter((r) => r.on).map((r) => r.id);
  assert.deepEqual(on.slice(0, 7), ["spotlight", "local:continue", "radar", "curator:for_you", "local:recently_added", "box:stashdb.org:favorites", "box:stashdb.org:trending"]);
  assert.ok(full.some((r) => r.id === "curator:dormant" && !r.on), "other Curator lanes are offered, switched off");
  assert.ok(full.some((r) => r.id === "box:stashdb.org:new" && !r.on));
});

test("only the first stash-box gets default rows; further ones are offered switched off", () => {
  const fans = c.boxFromConfig({ endpoint: "https://fansdb.cc/graphql", api_key: "k", name: "FansDB" });
  const layout = c.defaultLayout(env({ boxes: [box, fans] }));
  assert.ok(layout.some((r) => r.id === "box:stashdb.org:trending" && r.on));
  assert.ok(layout.filter((r) => r.id.startsWith("box:fansdb.cc:")).every((r) => !r.on));
});

test("disableExternal drops every stash-box row", () => {
  assert.ok(c.availableRows(env({ disableExternal: true })).every((id) => !id.startsWith("box:")));
});

test("a saved layout keeps its order and choices, and new rows join in their default place", () => {
  const saved = [
    { id: "local:random", on: true },
    { id: "local:continue", on: false },
    { id: "spotlight", on: true },
    { id: "bogus:row", on: true },
    { id: "local:random", on: false }
  ];
  const layout = c.resolveLayout(saved, env({ curator: true }));
  assert.deepEqual(layout.slice(0, 4).map((r) => [r.id, r.on]), [["local:random", true], ["local:continue", false], ["radar", true], ["curator:for_you", true]]);
  assert.ok(!layout.some((r) => r.id === "bogus:row"));
  assert.equal(layout.filter((r) => r.id === "local:random").length, 1);
  assert.equal(new Set(layout.map((r) => r.id)).size, layout.length);
});

test("rows of a missing source stay in the saved layout but aren't shown, and return with it", () => {
  const withCurator = c.resolveLayout([{ id: "curator:revisit", on: true }, { id: "local:random", on: true }], env({ curator: true }));
  const without = c.resolveLayout(withCurator, env({ curator: false }));
  assert.ok(without.some((r) => r.id === "curator:revisit" && r.on));
  assert.ok(!c.visibleRows(without, env({ curator: false })).includes("curator:revisit"));
  assert.ok(c.visibleRows(without, env({ curator: true })).includes("curator:revisit"));
});

test("settings fall back to defaults and clamp numbers", () => {
  assert.deepEqual(c.readSettings(undefined), { hideNativeRows: false, disableExternal: false, hideOwned: false, cacheHours: 6, radarDecisionDays: 30, itemsPerRow: 12, layout: null });
  assert.equal(c.readSettings({ radarDecisionDays: 0 }).radarDecisionDays, 1);
  const s = c.readSettings({ hideOwned: true, cacheHours: 500, itemsPerRow: "2", layout: "[{\"id\":\"spotlight\",\"on\":true}]" });
  assert.equal(s.hideOwned, true);
  assert.equal(s.cacheHours, 168);
  assert.equal(s.itemsPerRow, 4);
  assert.deepEqual(s.layout, [{ id: "spotlight", on: true }]);
  assert.equal(c.readSettings({ layout: "{broken" }).layout, null);
  assert.equal(c.readSettings({ layout: "{\"a\":1}" }).layout, null);
  assert.equal(c.readSettings({ hideNativeRows: "true" }).hideNativeRows, false, "only a real boolean counts");
});

test("serializeLayout round-trips through readSettings", () => {
  const layout = c.defaultLayout(env());
  assert.deepEqual(c.readSettings({ layout: c.serializeLayout(layout) }).layout, layout);
});

test("seeds are stable per day, row and mix, and fit Stash's random sort", () => {
  const day = c.dayKey(new Date(2026, 9, 23, 13, 5));
  assert.equal(day, "20261023");
  assert.equal(c.rowSeed(day, "local:random", 0), c.rowSeed(day, "local:random", 0));
  assert.notEqual(c.rowSeed(day, "local:random", 0), c.rowSeed(day, "local:random", 1));
  assert.notEqual(c.rowSeed(day, "local:random", 0), c.rowSeed(day, "local:top_rated", 0));
  assert.notEqual(c.rowSeed(day, "local:random", 0), c.rowSeed("20261024", "local:random", 0));
  for (let i = 0; i < 200; i++) {
    const s = c.hashSeed(`x${i}`);
    assert.ok(Number.isInteger(s) && s >= 1 && s < 1e9);
  }
});

test("local row queries", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  const ctx = { count: 12, seed: 42, now };
  assert.deepEqual(c.localRowQuery("continue", ctx), {
    filter: { per_page: 12, sort: "last_played_at", direction: "DESC" },
    scene_filter: { resume_time: { value: 0, modifier: "GREATER_THAN" } }
  });
  assert.deepEqual(c.localRowQuery("rediscover", ctx).scene_filter.last_played_at, { value: "2026-07-25", modifier: "LESS_THAN" });
  assert.equal(c.localRowQuery("random", ctx).filter.sort, "random_42");
  assert.deepEqual(c.localRowQuery("unwatched_favorites", ctx).scene_filter, {
    performer_favorite: true, play_count: { value: 0, modifier: "EQUALS" }, resume_time: { value: 0, modifier: "EQUALS" }
  });
  assert.equal(c.localRowQuery("tag_of_the_day", ctx), null, "nothing without a picked tag");
  assert.deepEqual(c.localRowQuery("tag_of_the_day", { ...ctx, pickedId: "7" }).scene_filter, { tags: { value: ["7"], modifier: "INCLUDES", depth: 0 } });
  assert.deepEqual(c.localRowQuery("studio_spotlight", { ...ctx, pickedId: "3" }).scene_filter, { studios: { value: ["3"], modifier: "INCLUDES", depth: 0 } });
  assert.equal(c.localRowQuery("nope", ctx), null);
});

test("pick queries want enough scenes and use the seed", () => {
  const q = c.pickQuery("tag_of_the_day", 9);
  assert.match(q.query, /findTags/);
  assert.deepEqual(q.variables, { filter: { per_page: 1, sort: "random_9" }, f: { scene_count: { value: 3, modifier: "GREATER_THAN" } } });
  assert.deepEqual(q.path, ["findTags", "tags"]);
  assert.match(c.pickQuery("studio_spotlight", 9).query, /findStudios/);
  assert.equal(c.pickQuery("random", 9), null);
});

test("box row inputs stop at today and follow up to 50 performers", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  const ctx = { count: 12, now };
  assert.deepEqual(c.boxRowInput("trending", ctx), { page: 1, per_page: 12, direction: "DESC", sort: "TRENDING" });
  assert.deepEqual(c.boxRowInput("favorites", ctx), { page: 1, per_page: 12, direction: "DESC", sort: "DATE", favorites: "ALL", date: { value: "2026-10-24", modifier: "LESS_THAN" } });
  assert.equal(c.boxRowInput("performers", ctx), null);
  const ids = Array.from({ length: 70 }, (_, i) => `p${i}`);
  assert.equal(c.boxRowInput("performers", { ...ctx, performerIds: ids }).performers.value.length, 50);
});

test("followed performers: favourites first, only IDs of this box, no duplicates", () => {
  const ep = "https://stashdb.org/graphql";
  const ids = c.followedPerformerIds([
    { favorite: false, stash_ids: [{ endpoint: ep, stash_id: "a" }] },
    { favorite: true, stash_ids: [{ endpoint: "https://fansdb.cc/graphql", stash_id: "x" }, { endpoint: ep, stash_id: "b" }] },
    { favorite: false, stash_ids: [{ endpoint: ep, stash_id: "a" }] },
    { favorite: false, stash_ids: [] }
  ], ep);
  assert.deepEqual(ids, ["b", "a"]);
});

test("box scenes become cards; women are named first", () => {
  const card = c.normalizeBoxScene({
    id: "s1", title: "A Title", release_date: "2026-10-01", duration: 1830,
    studio: { name: "Acme" },
    images: [{ url: "tall", width: 400, height: 900 }, { url: "wide-big", width: 1920, height: 1080 }, { url: "wide", width: 600, height: 338 }],
    performers: [{ as: null, performer: { name: "Jim", gender: "MALE" } }, { as: "Janie", performer: { name: "Jane", gender: "FEMALE" } }]
  }, box);
  assert.deepEqual(card, {
    id: "s1", title: "A Title", date: "2026-10-01", duration: 1830, studio: "Acme",
    performers: ["Janie", "Jim"], image: "wide", url: "https://stashdb.org/scenes/s1"
  });
  assert.equal(c.normalizeBoxScene({ id: "s2", images: [], performers: [] }, box).image, null);
  assert.equal(c.pickImage([{ url: "only-tall", width: 100, height: 300 }]), "only-tall");
});

test("ownership marks or hides scenes already in the library", () => {
  const ep = "https://stashdb.org/graphql";
  const owned = c.ownedMap([
    { id: "1", stash_ids: [{ endpoint: ep, stash_id: "s1" }] },
    { id: "9", stash_ids: [{ endpoint: "https://fansdb.cc/graphql", stash_id: "s2" }] }
  ], ep);
  assert.deepEqual(owned, { s1: "1" });
  const cards = [{ id: "s1" }, { id: "s2" }];
  assert.deepEqual(c.applyOwnership(cards, owned, false), [{ id: "s1", localId: "1" }, { id: "s2" }]);
  assert.deepEqual(c.applyOwnership(cards, owned, true), [{ id: "s2" }]);
});

function memoryStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i],
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}

test("cache entries expire, survive broken storage and can be cleared", () => {
  const s = memoryStorage();
  c.cacheSet(s, "row", { a: 1 }, 1000);
  assert.deepEqual(c.cacheGet(s, "row", 500, 1400), { a: 1 });
  assert.equal(c.cacheGet(s, "row", 500, 1500), null, "expired");
  assert.equal(c.cacheGet(s, "row", 500, 900), null, "from the future");
  assert.equal(c.cacheGet(s, "row", 0, 1001), null, "caching off");
  s.setItem(c.CACHE_PREFIX + "bad", "{nope");
  assert.equal(c.cacheGet(s, "bad", 500, 1000), null);
  s.setItem("other-app", "x");
  c.cacheClear(s);
  assert.equal(s.length, 1);
  assert.equal(s.getItem("other-app"), "x");
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(c.cacheGet(throwing, "row", 500, 1000), null);
  assert.doesNotThrow(() => c.cacheSet(throwing, "row", 1, 1000));
  assert.doesNotThrow(() => c.cacheClear(throwing));
});

test("Curator is used only when installed and enabled; its order is kept", () => {
  assert.equal(c.curatorAvailable([{ id: "stash-curator", enabled: true }]), true);
  assert.equal(c.curatorAvailable([{ id: "stash-curator", enabled: false }]), false);
  assert.equal(c.curatorAvailable(null), false);
  assert.deepEqual(c.curatorSceneIds({ items: [{ scene_id: "5" }, { scene_id: 3 }, { scene_id: "5" }, { scene_id: "x" }, {}] }), ["5", "3"]);
  assert.deepEqual(c.curatorSceneIds(null), []);
  assert.deepEqual(c.orderByIds([{ id: "3" }, { id: "5" }], ["5", "9", "3"]).map((s) => s.id), ["5", "3"]);
});

test("texts: German and English, fallbacks, placeholders", () => {
  assert.equal(c.langOf("de-DE"), "de");
  assert.equal(c.langOf("fr-FR"), "en");
  assert.equal(c.langOf(undefined), "en");
  assert.equal(c.t("de", "row.box.trending", { box: "StashDB" }), "Angesagt auf StashDB");
  assert.equal(c.t("en", "unknown.key"), "unknown.key");
  assert.equal(c.rowTitle("en", "local:tag_of_the_day", env(), { id: "1", name: "Outdoor" }), "Tag of the day: Outdoor");
  assert.equal(c.rowTitle("en", "local:tag_of_the_day", env(), null), "Tag of the day");
  assert.equal(c.rowTitle("de", "box:stashdb.org:favorites", env()), "Neu von deinen StashDB-Favoriten");
  assert.equal(c.rowTitle("en", "curator:for_you", env()), "For you");
});

test("every text exists in both languages", () => {
  assert.deepEqual(Object.keys(c.STRINGS.de).sort(), Object.keys(c.STRINGS.en).sort());
  for (const id of c.availableRows(env({ curator: true }))) {
    assert.notEqual(c.rowTitle("de", id, env()), id, id);
  }
});

test("durations", () => {
  assert.equal(c.formatDuration(1830), "30:30");
  assert.equal(c.formatDuration(3725), "1:02:05");
  assert.equal(c.formatDuration(0), "");
  assert.equal(c.formatDuration(null), "");
});

test("local row links", () => {
  assert.equal(c.localRowLink("recently_added"), "/scenes?sortby=created_at&sortdir=desc");
  assert.equal(c.localRowLink("tag_of_the_day", { id: "4" }), "/tags/4");
  assert.equal(c.localRowLink("studio_spotlight", null), null);
  assert.equal(c.localRowLink("random"), null);
});

test("download links: StashDB scenes not in the library, opening with stasharr's search", () => {
  const card = { id: "s1", url: "https://stashdb.org/scenes/s1" };
  assert.equal(c.downloadLink(card, box), "https://stashdb.org/scenes/s1#stasharr-search");
  assert.equal(c.downloadLink({ ...card, localId: "4" }, box), null, "already in the library");
  const fans = c.boxFromConfig({ endpoint: "https://fansdb.cc/graphql", api_key: "k" });
  assert.equal(c.downloadLink({ id: "x", url: "https://fansdb.cc/scenes/x" }, fans), null, "stasharr only works on StashDB");
  assert.equal(c.downloadLink(null, box), null);
});

const radar = (id, since, extra = {}) => ({ id, name: `P${id}`, custom_fields: since ? { radar: since } : {}, ...extra });

test("radar: the day comes from the custom field, in local days", () => {
  assert.equal(c.radarSince(radar("1", "2026-10-01")), "2026-10-01");
  assert.equal(c.radarSince(radar("1", null)), null);
  assert.equal(c.radarSince({ id: "1", custom_fields: { radar: "soon" } }), null);
  assert.equal(c.radarSince({ id: "1" }), null);
  assert.equal(c.radarDays("2026-10-01", new Date(2026, 9, 27, 23, 59)), 26);
  assert.equal(c.radarDays("2026-10-27", new Date(2026, 9, 27, 0, 1)), 0);
  assert.equal(c.radarDays("2026-10-28", new Date(2026, 9, 27)), 0, "never negative");
  assert.equal(c.localIsoDate(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
});

test("radar: the three most recent get a row, plus a different other one each day", () => {
  const people = [radar("1", "2026-09-01"), radar("2", "2026-10-20"), radar("3", "2026-10-25"), radar("4", "2026-10-10"),
    radar("5", "2026-08-01"), radar("6", "2026-07-01"), radar("7", null)];
  const today = c.radarPick(people, "20261027").map((p) => p.id);
  assert.deepEqual(today.slice(0, 3), ["3", "2", "4"]);
  assert.equal(today.length, 4);
  assert.ok(["1", "5", "6"].includes(today[3]));
  const days = new Set(Array.from({ length: 30 }, (_, i) => c.radarPick(people, `202611${String(i + 1).padStart(2, "0")}`)[3].id));
  assert.ok(days.size > 1, "the fourth changes from day to day");
  assert.deepEqual(c.radarPick(people.slice(0, 2), "20261027").map((p) => p.id), ["2", "1"]);
  assert.deepEqual(c.radarPick([], "20261027"), []);
});

test("radar: the decision is due after the set days or three scenes watched", () => {
  assert.equal(c.radarDecisionDue(29, 2, 30), false);
  assert.equal(c.radarDecisionDue(30, 0, 30), true);
  assert.equal(c.radarDecisionDue(2, 3, 30), true);
});

test("radar: queries for the library part and the stash-box part", () => {
  const now = Date.UTC(2026, 9, 27, 12);
  assert.deepEqual(c.radarLocalQuery(5, { count: 12, seed: 7 }), {
    filter: { per_page: 12, sort: "random_7" },
    scene_filter: { performers: { value: ["5"], modifier: "INCLUDES" }, play_count: { value: 0, modifier: "EQUALS" } }
  });
  assert.deepEqual(c.radarBoxInput("sdb-1", { count: 24, now }), {
    page: 1, per_page: 24, direction: "DESC", sort: "POPULARITY",
    date: { value: "2026-10-28", modifier: "LESS_THAN" },
    performers: { value: ["sdb-1"], modifier: "INCLUDES" }
  });
});

test("radar: StashDB first for the stash-box part, else another box the performer is on", () => {
  const fans = c.boxFromConfig({ endpoint: "https://fansdb.cc/graphql", api_key: "k" });
  const both = { stash_ids: [{ endpoint: "https://fansdb.cc/graphql", stash_id: "f1" }, { endpoint: "https://stashdb.org/graphql", stash_id: "s1" }] };
  assert.deepEqual(c.radarBox(both, [fans, box]), { box, stashId: "s1" });
  assert.deepEqual(c.radarBox({ stash_ids: [{ endpoint: "https://fansdb.cc/graphql", stash_id: "f1" }] }, [box, fans]), { box: fans, stashId: "f1" });
  assert.equal(c.radarBox({ stash_ids: [] }, [box]), null);
});

test("radar: Curator's hunt becomes cards, best match first, without what Curator finds locally", () => {
  const scene = (title) => ({ title, release_date: "2026-10-01", images: [{ url: `${title}.jpg`, width: 640, height: 360 }], performers: [], studio: { name: "S" } });
  const cards = c.curatorHuntCards({ items: [
    { id: "h1", score: 0.2, payload: scene("one") },
    { id: "h2", score: 0.9, payload: scene("two") },
    { id: "h3", score: 0.95, payload: { ...scene("three"), curator_local_match: { type: "phash" } } },
    { id: "h4", payload: null }
  ] }, box);
  assert.deepEqual(cards.map((x) => [x.id, x.title, x.url]), [["h2", "two", "https://stashdb.org/scenes/h2"], ["h1", "one", "https://stashdb.org/scenes/h1"]]);
  assert.deepEqual(c.curatorHuntCards(null, box), []);
});

test("followed performers: favourites, then the radar, then the rest", () => {
  const ep = "https://stashdb.org/graphql";
  const p = (sid, extra) => ({ stash_ids: [{ endpoint: ep, stash_id: sid }], ...extra });
  assert.deepEqual(c.followedPerformerIds([p("rest"), p("radar", { custom_fields: { radar: "2026-10-01" } }), p("fav", { favorite: true })], ep), ["fav", "radar", "rest"]);
});

test("radar row titles", () => {
  assert.equal(c.rowTitle("de", "radar", env(), { name: "Jane Doe" }), "Mehr von Jane Doe");
  assert.equal(c.rowTitle("en", "radar", env(), null), "More from performers on your radar");
});
