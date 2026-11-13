/*
 * Stashboard core: the pure logic behind the dashboard — the row catalogue,
 * layouts, query building, daily seeds, caching and texts. No DOM, no React,
 * no network: stashboard.js does all of that. Loaded first (see
 * stashboard.yml) and required directly by the tests in tests/.
 */
(function (root) {
  "use strict";

  const PLUGIN_ID = "stashboard";
  // Stash Curator runs inside Stashboard (curator/, see CURATOR.md). The
  // separate plugin it replaces had this id; its settings are taken over.
  const OLD_CURATOR_ID = "stash-curator";

  /* ------------------------------------------------------------------ *
   * Stash-boxes                                                         *
   * ------------------------------------------------------------------ */

  // Stash-boxes the dashboard can query straight from the browser. Stash's
  // Content-Security-Policy only lets a plugin connect to origins its yml
  // lists under ui.csp.connect-src, so this list and that one must match
  // (tests/project.test.js checks it). Other endpoints configured in Stash
  // are shown as unsupported instead of failing silently.
  const KNOWN_BOXES = [
    { host: "stashdb.org", origin: "https://stashdb.org", name: "StashDB" },
    { host: "fansdb.cc", origin: "https://fansdb.cc", name: "FansDB" },
    { host: "pmvstash.org", origin: "https://pmvstash.org", name: "PMV Stash" },
    { host: "javstash.org", origin: "https://javstash.org", name: "JAV Stash" }
  ];

  // Stash's configured stash-box ({ endpoint, api_key, name }) → what the
  // dashboard needs to query it, or null if it isn't one of KNOWN_BOXES.
  function boxFromConfig(box) {
    let url;
    try {
      url = new URL(String((box && box.endpoint) || "").trim());
    } catch (e) {
      return null;
    }
    const known = KNOWN_BOXES.find((k) => k.host === url.hostname.toLowerCase() && url.protocol === "https:");
    if (!known) return null;
    return {
      host: known.host,
      name: (box.name || "").trim() || known.name,
      endpoint: box.endpoint.trim(),
      site: known.origin,
      apiKey: (box.api_key || "").trim()
    };
  }

  // Splits Stash's stash-box list into usable boxes (first one per host) and
  // the endpoints left out, for the hint in the customise dialog.
  function usableBoxes(stashBoxes) {
    const boxes = [];
    const unsupported = [];
    for (const raw of stashBoxes || []) {
      const box = boxFromConfig(raw);
      if (!box) unsupported.push((raw && (raw.name || raw.endpoint)) || "?");
      else if (!boxes.some((b) => b.host === box.host)) boxes.push(box);
    }
    return { boxes, unsupported };
  }

  /* ------------------------------------------------------------------ *
   * Row catalogue                                                       *
   * ------------------------------------------------------------------ */

  const LOCAL_ROWS = [
    "continue", "recently_added", "unwatched_favorites", "tag_of_the_day",
    "rediscover", "studio_spotlight", "top_rated", "random"
  ];
  const CURATOR_LANES = ["for_you", "best_bets", "revisit", "stretch", "blind_spots", "dormant"];
  const BOX_ROWS = ["favorites", "trending", "performers", "new"];
  // Discover's own modules, from Curator's Find (Expand, Similar, Performer
  // Hunt) on StashDB.
  const DISCOVER_ROWS = ["pick", "faces", "matches", "like", "fresh", "hunt", "shortlist"];

  // Modules on by default, in this order. Modules of other kinds are
  // available but start switched off. Box modules apply to the first usable
  // stash-box only. Curator's Find, the radar and the stash-box modules
  // make the Discover tab (rowZone).
  const DEFAULT_ON = [
    "spotlight",
    "local:continue",
    "bubbles",
    "curator:for_you",
    "local:tag_of_the_day",
    "local:studio_spotlight",
    "local:rediscover",
    "local:random",
    ...DISCOVER_ROWS.map((k) => `discover:${k}`),
    "radar",
    "box:*:trending",
    "box:*:favorites"
  ];

  // How wide a module is (in twelfths of the page; modules in a line grow
  // to fill it when a neighbour has nothing to show) and how many scenes it
  // shows. Anything not listed is a plain tile of four.
  const MODULES = {
    spotlight: { span: 8, count: 5 },
    "local:continue": { span: 4, count: 3 },
    bubbles: { span: 12, count: 16 },
    "curator:for_you": { span: 7, count: 5 },
    "local:tag_of_the_day": { span: 5, count: 3 },
    "local:studio_spotlight": { span: 4, count: 3 },
    "local:rediscover": { span: 5, count: 1 },
    "local:random": { span: 3, count: 1 },
    radar: { span: 4, count: 4, more: 12 },
    "box:trending": { span: 4, count: 5, more: 20 },
    "discover:pick": { span: 8, count: 12 },
    "discover:faces": { span: 4, count: 6, more: 18 },
    "discover:matches": { span: 12, count: 8, more: 32 },
    "discover:like": { span: 7, count: 4, more: 12 },
    "discover:fresh": { span: 5, count: 5, more: 20 },
    "discover:hunt": { span: 12, count: 8, more: 32 },
    "discover:shortlist": { span: 12, count: 4, more: 40 }
  };
  const TILE = { span: 6, count: 4 };
  // Discover modules load `more` and show the rest on "More".
  const BOX_TILE = { span: 4, count: 4, more: 16 };

  // Each module's colour (a hue) and symbol, so they tell apart at a glance.
  const THEMES = {
    "local:continue": { icon: "⏯", hue: 205 },
    "curator:for_you": { icon: "🏆", hue: 45 },
    "local:tag_of_the_day": { icon: "🏷", hue: 280 },
    "local:studio_spotlight": { icon: "🎬", hue: 185 },
    "local:rediscover": { icon: "🕰", hue: 25 },
    "local:random": { icon: "🎲", hue: 330 },
    "local:recently_added": { icon: "🆕", hue: 145 },
    "local:unwatched_favorites": { icon: "❤", hue: 350 },
    "local:top_rated": { icon: "⭐", hue: 48 },
    "curator:best_bets": { icon: "🎯", hue: 8 },
    "curator:revisit": { icon: "🔁", hue: 170 },
    "curator:stretch": { icon: "🧗", hue: 95 },
    "curator:blind_spots": { icon: "🔦", hue: 255 },
    "curator:dormant": { icon: "💤", hue: 220 },
    radar: { icon: "📡", hue: 160 },
    "box:trending": { icon: "🔥", hue: 15 },
    "box:favorites": { icon: "💫", hue: 300 },
    "box:performers": { icon: "👥", hue: 200 },
    "box:new": { icon: "✨", hue: 55 },
    "discover:pick": { icon: "🧭", hue: 38 },
    "discover:faces": { icon: "👯", hue: 318 },
    "discover:matches": { icon: "🔮", hue: 268 },
    "discover:like": { icon: "🔗", hue: 190 },
    "discover:fresh": { icon: "🌱", hue: 128 },
    "discover:hunt": { icon: "🏹", hue: 2 },
    "discover:shortlist": { icon: "📌", hue: 212 }
  };

  function moduleTheme(id) {
    const row = parseRowId(id);
    if (!row) return null;
    if (row.source === "box") return THEMES[`box:${row.kind}`] || null;
    return THEMES[id] || null;
  }

  function moduleSize(id) {
    const row = parseRowId(id);
    if (!row) return TILE;
    if (row.source === "box") return MODULES[`box:${row.kind}`] || BOX_TILE;
    return MODULES[id] || TILE;
  }

  // Up next: up to this many scenes to continue, filled up to UPNEXT_TOTAL
  // with what's new in the library (at least one).
  const UPNEXT_TOTAL = 4;
  const TAG_CHIPS = 4;

  // Two zones: what's in your library (with Curator's picks from it) on the
  // front page, and Discover, for what isn't (yet), in its own tab.
  const ZONES = ["library", "discover"];

  function rowZone(id) {
    const row = parseRowId(id);
    return row && (row.source === "box" || row.source === "radar" || row.source === "discover") ? "discover" : "library";
  }

  // Row ids by zone, each in its given order.
  function byZone(ids) {
    const zones = { library: [], discover: [] };
    for (const id of ids) zones[rowZone(id)].push(id);
    return zones;
  }

  // Every row id that can be shown with what's available right now.
  function availableRows(env) {
    const ids = ["spotlight", "bubbles", "radar", ...LOCAL_ROWS.map((r) => `local:${r}`)];
    if (env.curator) ids.push(...CURATOR_LANES.map((l) => `curator:${l}`));
    if (!env.disableExternal) {
      if (env.curator && stashdbBox(env)) ids.push(...DISCOVER_ROWS.map((k) => `discover:${k}`));
      for (const box of env.boxes || []) ids.push(...BOX_ROWS.map((k) => `box:${box.host}:${k}`));
    }
    return ids;
  }

  function parseRowId(id) {
    const parts = String(id).split(":");
    if (parts[0] === "spotlight" && parts.length === 1) return { source: "spotlight" };
    if (parts[0] === "radar" && parts.length === 1) return { source: "radar" };
    if (parts[0] === "bubbles" && parts.length === 1) return { source: "bubbles" };
    if (parts[0] === "local" && parts.length === 2 && LOCAL_ROWS.includes(parts[1])) return { source: "local", kind: parts[1] };
    if (parts[0] === "curator" && parts.length === 2 && CURATOR_LANES.includes(parts[1])) return { source: "curator", lane: parts[1] };
    if (parts[0] === "discover" && parts.length === 2 && DISCOVER_ROWS.includes(parts[1])) return { source: "discover", kind: parts[1] };
    if (parts[0] === "box" && parts.length === 3 && BOX_ROWS.includes(parts[2])) return { source: "box", host: parts[1], kind: parts[2] };
    return null;
  }

  function defaultLayout(env) {
    const available = availableRows(env);
    const firstBox = env.disableExternal ? null : (env.boxes || [])[0];
    const on = DEFAULT_ON
      .map((id) => (firstBox ? id.replace("box:*:", `box:${firstBox.host}:`) : id))
      .filter((id) => available.includes(id));
    return [
      ...on.map((id) => ({ id, on: true })),
      ...available.filter((id) => !on.includes(id)).map((id) => ({ id, on: false }))
    ];
  }

  // The saved layout, completed: saved rows keep their order and on/off
  // state (also rows that aren't available right now, so they return when
  // Curator or a stash-box comes back). Rows the saved layout doesn't know
  // yet get their default state: one on by default goes after the row it
  // follows in the default layout, one off by default to the end.
  function resolveLayout(saved, env) {
    const defaults = defaultLayout(env);
    const seen = new Set();
    const rows = [];
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (!entry || typeof entry.id !== "string" || !parseRowId(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      rows.push({ id: entry.id, on: entry.on !== false });
    }
    defaults.forEach((entry, i) => {
      if (seen.has(entry.id)) return;
      let at = rows.length;
      for (let j = entry.on ? i - 1 : -1; j >= 0; j--) {
        const k = rows.findIndex((r) => r.id === defaults[j].id);
        if (k !== -1) { at = k + 1; break; }
      }
      rows.splice(at, 0, { ...entry });
      seen.add(entry.id);
    });
    return rows;
  }

  // The rows to render, in order.
  function visibleRows(layout, env) {
    const available = new Set(availableRows(env));
    return layout.filter((r) => r.on && available.has(r.id)).map((r) => r.id);
  }

  /* ------------------------------------------------------------------ *
   * Settings                                                            *
   * ------------------------------------------------------------------ */

  function clampNumber(value, fallback, min, max) {
    const n = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // Stash's plugin settings map for this plugin → settings with defaults.
  // `modules` is written by the customise dialog as a JSON string. (Before
  // 2.0 it was `layout`, for rows; that one is left alone and unused.)
  function readSettings(map) {
    const m = map || {};
    let layout = null;
    if (typeof m.modules === "string" && m.modules.trim()) {
      try {
        const parsed = JSON.parse(m.modules);
        if (Array.isArray(parsed)) layout = parsed;
      } catch (e) { /* broken value: fall back to the default layout */ }
    }
    return {
      hideNativeRows: m.hideNativeRows === true,
      disableExternal: m.disableExternal === true,
      hideOwned: m.hideOwned === true,
      cacheHours: clampNumber(m.cacheHours, 6, 0, 168),
      radarDecisionDays: Math.round(clampNumber(m.radarDecisionDays, 30, 1, 365)),
      watchedPercent: Math.round(clampNumber(m.watchedPercent, 80, 0, 98)),
      layout
    };
  }

  function serializeLayout(layout) {
    return JSON.stringify(layout.map((r) => ({ id: r.id, on: !!r.on })));
  }

  /* ------------------------------------------------------------------ *
   * Seeds: "random", but stable for a day                               *
   * ------------------------------------------------------------------ */

  function dayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  // FNV-1a, folded into the range Stash's random_<seed> sort takes.
  function hashSeed(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h % 999999937) + 1;
  }

  // One seed per row and day; "New mix" bumps `mix` for a different draw.
  function rowSeed(day, rowId, mix) {
    return hashSeed(`${day}|${rowId}|${mix || 0}`);
  }

  function isoDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /* ------------------------------------------------------------------ *
   * Local rows (Stash GraphQL)                                          *
   * ------------------------------------------------------------------ */

  const REDISCOVER_DAYS = 90;

  // Stash only forgets where you stopped past 98% (end credits and all), so
  // "Continue watching" fills up with scenes you're done with. Scenes past
  // `percent` (0 = off) count as watched; the row asks for this many times
  // its size to still fill up after leaving those out.
  const CONTINUE_OVERFETCH = 2;

  function pastWatched(scene, percent) {
    if (!percent || !scene) return false;
    const duration = scene.files && scene.files[0] && scene.files[0].duration;
    return duration > 0 && scene.resume_time > 0 && scene.resume_time / duration >= percent / 100;
  }

  // The FindScenes variables ({ filter, scene_filter }) for a local row.
  // tag_of_the_day and studio_spotlight need the picked tag/studio id first
  // (see pickQuery); without one there's nothing to show.
  function localRowQuery(kind, ctx) {
    const per = ctx.count;
    const random = `random_${ctx.seed}`;
    switch (kind) {
      case "continue":
        return { filter: { per_page: per, sort: "last_played_at", direction: "DESC" },
          scene_filter: { resume_time: { value: 0, modifier: "GREATER_THAN" } } };
      case "recently_added":
        return { filter: { per_page: per, sort: "created_at", direction: "DESC" } };
      // Not started either: a half-watched scene is under "continue".
      case "unwatched_favorites":
        return { filter: { per_page: per, sort: random },
          scene_filter: { performer_favorite: true, play_count: { value: 0, modifier: "EQUALS" }, resume_time: { value: 0, modifier: "EQUALS" } } };
      case "rediscover":
        return { filter: { per_page: per, sort: random },
          scene_filter: {
            play_count: { value: 0, modifier: "GREATER_THAN" },
            last_played_at: { value: isoDate(ctx.now - REDISCOVER_DAYS * 86400000), modifier: "LESS_THAN" }
          } };
      case "top_rated":
        return { filter: { per_page: per, sort: random },
          scene_filter: { rating100: { value: 79, modifier: "GREATER_THAN" } } };
      // Surprise me: something not started yet.
      case "random":
        return { filter: { per_page: per, sort: random },
          scene_filter: { play_count: { value: 0, modifier: "EQUALS" }, resume_time: { value: 0, modifier: "EQUALS" } } };
      case "tag_of_the_day":
        if (!ctx.pickedId) return null;
        return { filter: { per_page: per, sort: random },
          scene_filter: { tags: { value: [ctx.pickedId], modifier: "INCLUDES", depth: 0 } } };
      case "studio_spotlight":
        if (!ctx.pickedId) return null;
        return { filter: { per_page: per, sort: random },
          scene_filter: { studios: { value: [ctx.pickedId], modifier: "INCLUDES", depth: 0 } } };
      default:
        return null;
    }
  }

  // At least this many scenes, so the day's tag or studio fills a row.
  const PICK_MIN_SCENES = 4;

  // The query that picks the day's tag or studio: one random entity with
  // enough scenes, the same all day.
  function pickQuery(kind, seed, many) {
    const filter = { per_page: many || 1, sort: `random_${seed}` };
    const count = { scene_count: { value: PICK_MIN_SCENES - 1, modifier: "GREATER_THAN" } };
    if (kind === "tag_of_the_day") {
      return { query: "query StashboardPickTag($filter: FindFilterType, $f: TagFilterType) { findTags(filter: $filter, tag_filter: $f) { tags { id name image_path } } }",
        variables: { filter, f: count }, path: ["findTags", "tags"] };
    }
    if (kind === "studio_spotlight") {
      return { query: "query StashboardPickStudio($filter: FindFilterType, $f: StudioFilterType) { findStudios(filter: $filter, studio_filter: $f) { studios { id name image_path scene_count } } }",
        variables: { filter, f: count }, path: ["findStudios", "studios"] };
    }
    return null;
  }

  // Where a row's "View all" goes inside Stash, if anywhere sensible.
  function localRowLink(kind, picked) {
    switch (kind) {
      case "recently_added": return "/scenes?sortby=created_at&sortdir=desc";
      case "tag_of_the_day": return picked ? `/tags/${picked.id}` : null;
      case "studio_spotlight": return picked ? `/studios/${picked.id}` : null;
      default: return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Stash-box rows                                                      *
   * ------------------------------------------------------------------ */

  const BOX_SCENES_QUERY = `query StashboardBoxScenes($input: SceneQueryInput!) {
  queryScenes(input: $input) {
    count
    scenes {
      id
      title
      release_date
      duration
      studio { id name }
      images { url width height }
      performers { as performer { id name gender } }
    }
  }
}`;

  // How many local performers the "new from your performers" row follows.
  const BOX_PERFORMERS_MAX = 50;

  // queryScenes input for a box row. Date-sorted rows stop at today:
  // stash-boxes list announced scenes with future dates.
  function boxRowInput(kind, ctx) {
    const base = { page: 1, per_page: ctx.count, direction: "DESC" };
    const released = { value: isoDate(ctx.now + 86400000), modifier: "LESS_THAN" };
    switch (kind) {
      case "trending":
        return { ...base, sort: "TRENDING" };
      case "favorites":
        return { ...base, sort: "DATE", favorites: "ALL", date: released };
      case "new":
        return { ...base, sort: "DATE", date: released };
      case "performers":
        if (!ctx.performerIds || !ctx.performerIds.length) return null;
        return { ...base, sort: "DATE", date: released,
          performers: { value: ctx.performerIds.slice(0, BOX_PERFORMERS_MAX), modifier: "INCLUDES" } };
      default:
        return null;
    }
  }

  // The local performers whose StashDB (or other box) IDs the performers
  // row follows: favourites first, then those on the radar, then the most
  // collected.
  function followedPerformerIds(performers, endpoint) {
    const rank = (p) => (p.favorite === true ? 0 : radarSince(p) ? 1 : 2);
    const ordered = (performers || []).slice().sort((a, b) => rank(a) - rank(b));
    const ids = [];
    for (const p of ordered) {
      const sid = (p.stash_ids || []).find((s) => s.endpoint === endpoint);
      if (sid && sid.stash_id && !ids.includes(sid.stash_id)) ids.push(sid.stash_id);
      if (ids.length === BOX_PERFORMERS_MAX) break;
    }
    return ids;
  }

  // A landscape image near card size if there is one; box images vary.
  function pickImage(images) {
    const list = (images || []).filter((i) => i && i.url);
    if (!list.length) return null;
    const landscape = list.filter((i) => !i.width || !i.height || i.width >= i.height);
    const pool = landscape.length ? landscape : list;
    const sized = pool.slice().sort((a, b) => Math.abs((a.width || 640) - 640) - Math.abs((b.width || 640) - 640));
    return sized[0].url;
  }

  // A box scene → the external card's data.
  function normalizeBoxScene(scene, box) {
    const performers = (scene.performers || [])
      .filter((a) => a && a.performer)
      .sort((a, b) => (a.performer.gender === "MALE") - (b.performer.gender === "MALE"))
      .map((a) => a.as || a.performer.name);
    return {
      id: scene.id,
      title: scene.title || "",
      date: scene.release_date || "",
      duration: typeof scene.duration === "number" ? scene.duration : null,
      studio: scene.studio ? scene.studio.name : "",
      performers,
      image: pickImage(scene.images),
      url: `${box.site}/scenes/${scene.id}`
    };
  }

  // Local copies by box scene ID ({ [boxSceneId]: localSceneId }), from a
  // FindScenes result whose scenes carry stash_ids.
  function ownedMap(localScenes, endpoint) {
    const owned = {};
    for (const s of localScenes || []) {
      for (const sid of s.stash_ids || []) {
        if (sid.endpoint === endpoint && !owned[sid.stash_id]) owned[sid.stash_id] = s.id;
      }
    }
    return owned;
  }

  // External cards with ownership applied: marked, or left out.
  function applyOwnership(cards, owned, hideOwned) {
    const marked = cards.map((c) => (owned[c.id] ? { ...c, localId: owned[c.id] } : c));
    return hideOwned ? marked.filter((c) => !c.localId) : marked;
  }

  /* ------------------------------------------------------------------ *
   * Radar: performers to see more of, short of a favourite              *
   * ------------------------------------------------------------------ */

  // The performer custom field that holds the day a performer went on the
  // radar (YYYY-MM-DD, local time). stasharr reads and writes the same
  // field, so it's shared between the two.
  const RADAR_FIELD = "radar";
  const RADAR_DECISION_PLAYS = 3;

  function localIsoDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // The day a performer went on the radar, or null.
  function radarSince(performer) {
    const value = performer && performer.custom_fields && performer.custom_fields[RADAR_FIELD];
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  }

  // Whole days on the radar, counted in local days.
  function radarDays(since, now) {
    const [y, m, d] = since.split("-").map(Number);
    const start = new Date(y, m - 1, d);
    const today = new Date(now);
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.max(0, Math.round((midnight - start) / 86400000));
  }

  // The radar performer to show: one at random, not the one shown last
  // (`lastId`) unless there's no one else. `random` is in [0, 1).
  function radarPick(performers, lastId, random) {
    const on = (performers || []).filter(radarSince);
    const others = on.length > 1 ? on.filter((p) => String(p.id) !== String(lastId)) : on;
    if (!others.length) return null;
    return others[Math.min(others.length - 1, Math.floor(random * others.length))];
  }

  // Time to ask "favourite or off the radar?": long enough on it, or
  // enough of the performer's scenes watched since.
  function radarDecisionDue(days, playsSince, decisionDays) {
    return days >= decisionDays || playsSince >= RADAR_DECISION_PLAYS;
  }

  // The performer's scenes in the library that haven't been played.
  function radarLocalQuery(performerId, ctx) {
    return {
      filter: { per_page: ctx.count, sort: `random_${ctx.seed}` },
      scene_filter: { performers: { value: [String(performerId)], modifier: "INCLUDES" }, play_count: { value: 0, modifier: "EQUALS" } }
    };
  }

  // The performer's most popular released scenes on a stash-box.
  function radarBoxInput(stashId, ctx) {
    return {
      page: 1, per_page: ctx.count, direction: "DESC", sort: "POPULARITY",
      date: { value: isoDate(ctx.now + 86400000), modifier: "LESS_THAN" },
      performers: { value: [stashId], modifier: "INCLUDES" }
    };
  }

  // The box and the performer's ID there for the stash-box part of the
  // row: StashDB first, else the first other box they're linked on.
  function radarBox(performer, boxes) {
    const ordered = (boxes || []).slice().sort((a, b) => (b.host === "stashdb.org") - (a.host === "stashdb.org"));
    for (const box of ordered) {
      const sid = (performer.stash_ids || []).find((s) => s.endpoint === box.endpoint);
      if (sid && sid.stash_id) return { box, stashId: sid.stash_id };
    }
    return null;
  }

  // Curator's Performer Hunt (get_performer_hunt) → the performer's scenes as
  // cards, best match first, without the ones Curator finds in the library
  // (by StashDB ID or pHash).
  function curatorHuntCards(output, box) {
    const items = output && Array.isArray(output.items) ? output.items : [];
    return items
      .filter((item) => item && item.id && item.payload && !item.payload.curator_local_match)
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .map((item) => normalizeBoxScene({ ...item.payload, id: item.id }, box));
  }

  /* ------------------------------------------------------------------ *
   * Discover: Curator's Find on StashDB                                 *
   * ------------------------------------------------------------------ */

  // Curator's Find works on StashDB only.
  function stashdbBox(env) {
    return ((env && env.boxes) || []).find((b) => b.host === "stashdb.org") || null;
  }

  // Expand answers with ready: false while its StashDB catalogue is still
  // being built (Curator's "Refresh Expand cache" task).
  function expandReady(output) {
    return !!output && output.ready !== false && !output.initializing;
  }

  function whyOf(payload) {
    return ((payload && payload.why) || []).filter((w) => typeof w === "string" && w.trim());
  }

  // Expand, Similar on StashDB and the shortlist → cards, best first as
  // Curator ranks them, without what Curator found in the library or was
  // dismissed.
  function expandCards(output, box) {
    const items = output && Array.isArray(output.items) ? output.items : [];
    return items
      .filter((item) => item && item.id && item.payload && !item.payload.curator_local_match && !item.dismissed && (item.entity_type || "scene") === "scene")
      .map((item) => ({
        ...normalizeBoxScene({ ...item.payload, id: item.id }, box),
        why: whyOf(item.payload),
        tags: (item.payload.tags || []).map((tg) => tg && tg.name).filter(Boolean).slice(0, 4),
        details: item.payload.details || "",
        shortlisted: !!item.shortlisted,
        curated: true
      }));
  }

  // A performer's picture: the most upright one.
  function portraitImage(images) {
    const list = (images || []).filter((i) => i && i.url);
    if (!list.length) return null;
    const upright = list.filter((i) => i.width && i.height && i.height > i.width);
    return (upright[0] || list[0]).url;
  }

  // Expand's performers (and the StashDB performer search) → faces.
  function expandPerformers(output, box) {
    const items = output && Array.isArray(output.items) ? output.items : [];
    return items
      .filter((item) => item && item.id)
      .map((item) => {
        const p = item.payload || item;
        return {
          id: String(item.id),
          name: p.name || "",
          disambiguation: p.disambiguation || "",
          image: portraitImage(p.images),
          why: whyOf(p)[0] || "",
          sceneCount: typeof p.scene_count === "number" ? p.scene_count : null,
          url: `${box.site}/performers/${item.id}`
        };
      })
      .filter((p) => p.name);
  }

  // Similar in the library → local scene ids, most similar first.
  function similarSceneIds(output) {
    const items = output && Array.isArray(output.items) ? output.items : [];
    const ids = [];
    for (const item of items) {
      const id = item && item.entity_id != null ? String(item.entity_id) : "";
      if (/^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // Which page of a ranked list to show: the first, then on each 🎲 one of
  // the next few (never the same twice in a row), so what comes still fits.
  const DISCOVER_PAGES = 5;

  function discoverPage(seed, roll) {
    return roll ? 2 + ((seed + roll) % (DISCOVER_PAGES - 1)) : 1;
  }

  function seededPick(list, seed) {
    return list && list.length ? list[seed % list.length] : null;
  }

  // Your performers with a StashDB id, to hunt for: { id (StashDB), name,
  // image, localId }.
  function huntTargets(performers, endpoint) {
    const seen = new Set();
    const out = [];
    for (const p of performers || []) {
      const sid = (p.stash_ids || []).find((s) => s.endpoint === endpoint);
      if (!sid || seen.has(sid.stash_id)) continue;
      seen.add(sid.stash_id);
      out.push({ id: sid.stash_id, name: p.name, image: p.image_path || null, localId: String(p.id) });
    }
    return out;
  }

  // The front page and the Discover tab share the route; ?stashboard=discover
  // picks the tab, so it can be linked to and Back works.
  const TAB_PARAM = "stashboard";

  function tabOf(search) {
    return new URLSearchParams(search || "").get(TAB_PARAM) === "discover" ? "discover" : "home";
  }

  function tabSearch(search, tab) {
    const params = new URLSearchParams(search || "");
    if (tab === "discover") params.set(TAB_PARAM, "discover");
    else params.delete(TAB_PARAM);
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  /* ------------------------------------------------------------------ *
   * stasharr                                                            *
   * ------------------------------------------------------------------ */

  // stasharr (github.com/brewing8309/stasharr), a Firefox extension, marks
  // the Stash page with this attribute when it's installed, and opens a
  // StashDB scene link ending in STASHARR_HASH with its Prowlarr search
  // already running.
  const STASHARR_ATTRIBUTE = "data-stasharr";
  const STASHARR_HASH = "#stasharr-search";

  // The download link for a stash-box card: only StashDB scenes (stasharr
  // works on stashdb.org) that aren't in the library yet.
  function downloadLink(card, box) {
    if (!card || card.localId || !box || box.host !== "stashdb.org") return null;
    return `${card.url}${STASHARR_HASH}`;
  }

  /* ------------------------------------------------------------------ *
   * Cache (external rows only; localStorage in the browser)             *
   * ------------------------------------------------------------------ */

  const CACHE_PREFIX = "stashboard:v1:";

  function cacheGet(storage, key, maxAgeMs, now) {
    if (!storage || maxAgeMs <= 0) return null;
    try {
      const raw = storage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.at !== "number" || now - entry.at >= maxAgeMs || now < entry.at) return null;
      return entry.value;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(storage, key, value, now) {
    if (!storage) return;
    try {
      storage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: now, value }));
    } catch (e) { /* full or blocked storage: just don't cache */ }
  }

  function cacheClear(storage) {
    if (!storage) return;
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => storage.removeItem(k));
    } catch (e) { /* nothing to clear */ }
  }

  /* ------------------------------------------------------------------ *
   * Curator                                                             *
   * ------------------------------------------------------------------ */

  // The separate Stash Curator plugin, still installed and switched on next
  // to the one inside Stashboard: then Curator runs twice.
  function oldCuratorEnabled(plugins) {
    return (plugins || []).some((p) => p && p.id === OLD_CURATOR_ID && p.enabled);
  }

  const CURATOR_TAKEN = "curatorSettingsTaken";

  // The old plugin's settings, for Stashboard's own, once: only the ones
  // Stashboard doesn't have yet. null when there's nothing to do.
  function takeOverCuratorSettings(own, old) {
    if (!old || own[CURATOR_TAKEN] === true) return null;
    const keys = Object.keys(old).filter((k) => !(k in own));
    const merged = { ...own, [CURATOR_TAKEN]: true };
    for (const k of keys) merged[k] = old[k];
    return keys.length ? merged : null;
  }

  // get_slate's answer → local scene IDs in Curator's order.
  function curatorSceneIds(output) {
    const items = output && Array.isArray(output.items) ? output.items : [];
    const ids = [];
    for (const item of items) {
      const id = item && item.scene_id != null ? String(item.scene_id) : "";
      if (/^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // FindScenes returns scene_ids in its own order; put them back in Curator's.
  function orderByIds(scenes, ids) {
    const byId = new Map((scenes || []).map((s) => [String(s.id), s]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * Texts                                                               *
   * ------------------------------------------------------------------ */

  const STRINGS = {
    en: {
      "row.spotlight": "Spotlight",
      "row.radar": "On your radar",
      "row.bubbles": "Your performers",
      "row.radar.one": "More from {name}",
      "row.local.continue": "Up next",
      "row.local.recently_added": "Recently added",
      "row.local.unwatched_favorites": "Unwatched with your favourites",
      "row.local.tag_of_the_day": "Tag of the day: {name}",
      "row.local.tag_of_the_day.plain": "Tag of the day",
      "row.local.rediscover": "Not watched in a while",
      "row.local.studio_spotlight": "Studio spotlight: {name}",
      "row.local.studio_spotlight.plain": "Studio spotlight",
      "row.local.top_rated": "Top rated",
      "row.local.random": "Surprise me",
      "row.curator.for_you": "Curator: your top 5 today",
      "row.curator.best_bets": "Best bets",
      "row.curator.revisit": "Revisit",
      "row.curator.stretch": "Stretch",
      "row.curator.blind_spots": "Blind spots",
      "row.curator.dormant": "Dormant",
      "row.box.favorites": "New from your {box} favourites",
      "row.box.trending": "Trending on {box}",
      "row.box.performers": "New on {box} with your performers",
      "row.box.new": "New on {box}",
      "source.local": "Your library",
      "source.curator": "Curator",
      "source.box": "{box}",
      "source.radar": "Library + StashDB",
      "action.viewAll": "View all",
      "action.mix": "New mix",
      "action.refresh": "Refresh",
      "action.customise": "Customise",
      "action.save": "Save",
      "action.cancel": "Cancel",
      "action.reset": "Reset to default",
      "action.up": "Move up",
      "action.down": "Move down",
      "action.play": "Play",
      "action.details": "Details",
      "action.nextPick": "↻ Another pick",
      "action.more": "More ({count})",
      "action.less": "Less",
      "action.again": "▶ Play again",
      "action.go": "▶ Go",
      "action.otherTag": "🎲",
      "action.otherTag.title": "Other tags",
      "upnext.left": "{minutes} min left",
      "upnext.started": "Started",
      "upnext.new": "New in your library",
      "upnext.added": "Added {when}",
      "when.today": "today",
      "when.yesterday": "yesterday",
      "when.days": "{days} days ago",
      "tile.scenes": "{count} scenes",
      "studio.counts": "{scenes} scenes · {unwatched} unwatched",
      "memory.ago": "Watched {when}",
      "memory.ask": "{title} – again?",
      "memory.plays": "watched {count}×",
      "surprise.title": "Surprise me",
      "surprise.sub": "A random scene you haven't started yet",
      "bubble.unwatched": "{count} unwatched",
      "bubble.none": "Nothing new",
      "radar.stat.here": "in your library",
      "radar.stat.unwatched": "unwatched",
      "radar.stat.since": "watched since 📡",
      "action.scrollLeft": "Scroll left",
      "action.scrollRight": "Scroll right",
      "action.watched": "✓ Watched",
      "action.watched.title": "Mark as watched: forgets where you stopped and adds a play",
      "action.remove": "✕ Remove",
      "action.remove.title": "Remove from Continue watching: deletes this unfinished viewing from the scene's history (the play and where you stopped)",
      "action.failed": "Failed",
      "radar.add": "📡 Radar",
      "radar.add.title": "Put on your radar: not a favourite, but more suggestions on the front page",
      "radar.on": "📡 On your radar",
      "radar.on.title": "On your radar since {date}. Click to take off.",
      "radar.since.today": "📡 On your radar since today",
      "radar.since.one": "📡 On your radar for 1 day",
      "radar.since": "📡 On your radar for {days} days",
      "radar.decide": "📡 On your radar since {date}, {plays} scenes watched since. A favourite?",
      "zone.library": "📚 From your library",
      "zone.discover": "🧭 Discover",
      "zone.discover.sub": "Not in your library (yet), found by Curator on StashDB and the stash-boxes. Every 🎲 brings something new.",
      "zone.hide": "Hide",
      "zone.show": "Show",
      "tab.home": "🏠 Home",
      "tab.discover": "🧭 Discover",
      "row.discover.pick": "Find of the day",
      "row.discover.faces": "New faces",
      "row.discover.matches": "Made for you on StashDB",
      "row.discover.like": "More like “{name}”",
      "row.discover.like.plain": "More like this",
      "row.discover.fresh": "Just released",
      "row.discover.hunt": "Performer Hunt",
      "row.discover.shortlist": "Your shortlist",
      "source.discover": "Curator + StashDB",
      "discover.shuffle": "🎲 Shuffle Discover",
      "discover.shuffle.title": "Every module draws something else",
      "discover.reroll": "🎲 Others",
      "discover.reroll.title": "Show others",
      "discover.next": "↻ Next find",
      "discover.notReady": "Curator is still building its StashDB catalogue for Discover.",
      "discover.build": "Build it now",
      "discover.building": "Started. This takes a few minutes; Discover fills up once it's done.",
      "discover.like.library": "In your library",
      "discover.like.box": "On StashDB",
      "discover.like.none": "Nothing similar yet.",
      "discover.hunt.search": "Search StashDB for anyone…",
      "discover.hunt.loading": "Curator is combing through {name}'s scenes on StashDB…",
      "discover.hunt.empty": "Nothing from {name} that you don't have.",
      "discover.hunt.none": "Pick a performer to hunt for, or search StashDB.",
      "discover.hunt.go": "🏹 Hunt",
      "discover.hunt.go.title": "Show their scenes in Performer Hunt",
      "discover.teaser": "Curator found scenes on StashDB that fit your taste.",
      "discover.teaser.open": "Open Discover →",
      "action.shortlist.title": "Keep on your shortlist",
      "action.unshortlist.title": "Take off your shortlist",
      "action.dismiss.title": "Not interested: won't be suggested again",
      "bubble.open.title": "Show {count} unwatched",
      "bubble.panel": "{name}: {count} unwatched",
      "bubble.panel.all": "All of {name}'s scenes →",
      "action.close": "Close",
      "radar.next": "🎲 Someone else",
      "radar.next.title": "Another performer from your radar ({count} on it)",
      "radar.divider": "Not in your library",
      "radar.favourite": "★ Favourite",
      "radar.remove": "✕ Off the radar",
      "radar.added": "{name} is on your radar",
      "radar.removed": "{name} is off your radar",
      "radar.favourited": "{name} is a favourite now",
      "radar.empty": "Nothing new: you've watched all of it in your library, and there's nothing on StashDB you're missing.",
      "action.download": "Download",
      "action.download.title": "Opens the scene on StashDB and searches Prowlarr with stasharr",
      "badge.owned": "✓ In your library",
      "spotlight.curator": "Curator's best bet",
      "spotlight.local": "From your top rated",
      "spotlight.random": "Today's pick",
      "customise.title": "Customise Stashboard",
      "customise.hint": "Choose what's on the front page and in which order. Saved in Stash, so it applies to every browser.",
      "customise.unsupported": "Not supported here (only {known}): {names}",
      "customise.noBoxes": "Add StashDB under Settings → Metadata Providers → Stash-box Endpoints to get its rows.",
      "notice.oldCurator": "Stash Curator is part of Stashboard now. Uninstall the separate Stash Curator plugin (Settings → Plugins), or Curator runs twice. Your Curator data has been copied over.",
      "error.noKey": "{box} needs a valid API key: Settings → Metadata Providers → Stash-box Endpoints.",
      "error.row": "Couldn't load this row: {message}",
      "error.curatorModel": "Curator has no recommendations yet. Run “Sync and build recommendations” in Curator."
    },
    de: {
      "row.spotlight": "Im Rampenlicht",
      "row.radar": "Auf deinem Radar",
      "row.bubbles": "Deine Performer",
      "row.radar.one": "Mehr von {name}",
      "row.local.continue": "Als Nächstes",
      "row.local.recently_added": "Neu hinzugefügt",
      "row.local.unwatched_favorites": "Ungesehen mit deinen Favoriten",
      "row.local.tag_of_the_day": "Tag des Tages: {name}",
      "row.local.tag_of_the_day.plain": "Tag des Tages",
      "row.local.rediscover": "Lange nicht gesehen",
      "row.local.studio_spotlight": "Studio im Rampenlicht: {name}",
      "row.local.studio_spotlight.plain": "Studio im Rampenlicht",
      "row.local.top_rated": "Bestbewertet",
      "row.local.random": "Überrasch mich",
      "row.curator.for_you": "Curator: deine Top 5 heute",
      "row.curator.best_bets": "Beste Treffer",
      "row.curator.revisit": "Wiedersehen",
      "row.curator.stretch": "Mal was anderes",
      "row.curator.blind_spots": "Blinde Flecken",
      "row.curator.dormant": "Lange ruhend",
      "row.box.favorites": "Neu von deinen {box}-Favoriten",
      "row.box.trending": "Angesagt auf {box}",
      "row.box.performers": "Neu auf {box} mit deinen Performern",
      "row.box.new": "Neu auf {box}",
      "source.local": "Deine Bibliothek",
      "source.curator": "Curator",
      "source.box": "{box}",
      "source.radar": "Bibliothek + StashDB",
      "action.viewAll": "Alle anzeigen",
      "action.mix": "Neu mischen",
      "action.refresh": "Aktualisieren",
      "action.customise": "Anpassen",
      "action.save": "Speichern",
      "action.cancel": "Abbrechen",
      "action.reset": "Standard wiederherstellen",
      "action.up": "Nach oben",
      "action.down": "Nach unten",
      "action.play": "Abspielen",
      "action.details": "Details",
      "action.nextPick": "↻ Anderer Tipp",
      "action.more": "Mehr ({count})",
      "action.less": "Weniger",
      "action.again": "▶ Nochmal",
      "action.go": "▶ Los",
      "action.otherTag": "🎲",
      "action.otherTag.title": "Andere Tags",
      "upnext.left": "noch {minutes} Min",
      "upnext.started": "Angefangen",
      "upnext.new": "Neu in deiner Bibliothek",
      "upnext.added": "Hinzugefügt {when}",
      "when.today": "heute",
      "when.yesterday": "gestern",
      "when.days": "vor {days} Tagen",
      "tile.scenes": "{count} Szenen",
      "studio.counts": "{scenes} Szenen · {unwatched} ungesehen",
      "memory.ago": "Gesehen {when}",
      "memory.ask": "{title} – mal wieder?",
      "memory.plays": "{count}× gesehen",
      "surprise.title": "Überrasch mich",
      "surprise.sub": "Eine zufällige Szene, die du noch nicht angefangen hast",
      "bubble.unwatched": "{count} ungesehen",
      "bubble.none": "Nichts Neues",
      "radar.stat.here": "bei dir",
      "radar.stat.unwatched": "ungesehen",
      "radar.stat.since": "gesehen seit 📡",
      "action.scrollLeft": "Nach links",
      "action.scrollRight": "Nach rechts",
      "action.watched": "✓ Gesehen",
      "action.watched.title": "Als gesehen markieren: vergisst die Stelle, an der du aufgehört hast, und zählt eine Wiedergabe",
      "action.remove": "✕ Entfernen",
      "action.remove.title": "Aus Weiterschauen entfernen: löscht diesen unvollständigen Eintrag aus dem Verlauf der Szene (die Wiedergabe und die Stelle, an der du aufgehört hast)",
      "action.failed": "Fehlgeschlagen",
      "radar.add": "📡 Radar",
      "radar.add.title": "Aufs Radar setzen: kein Favorit, aber mehr Vorschläge auf der Startseite",
      "radar.on": "📡 Auf deinem Radar",
      "radar.on.title": "Seit {date} auf deinem Radar. Klicken zum Entfernen.",
      "radar.since.today": "📡 Seit heute auf deinem Radar",
      "radar.since.one": "📡 Seit 1 Tag auf deinem Radar",
      "radar.since": "📡 Seit {days} Tagen auf deinem Radar",
      "radar.decide": "📡 Seit {date} auf deinem Radar, seitdem {plays} Szenen gesehen. Ein Favorit?",
      "zone.library": "📚 Aus deiner Bibliothek",
      "zone.discover": "🧭 Entdecken",
      "zone.discover.sub": "Noch nicht in deiner Sammlung, gefunden von Curator auf StashDB und den Stash-Boxen. Jedes 🎲 bringt etwas Neues.",
      "zone.hide": "Einklappen",
      "zone.show": "Ausklappen",
      "tab.home": "🏠 Start",
      "tab.discover": "🧭 Discover",
      "row.discover.pick": "Fund des Tages",
      "row.discover.faces": "Neue Gesichter",
      "row.discover.matches": "Für dich auf StashDB",
      "row.discover.like": "Mehr wie „{name}“",
      "row.discover.like.plain": "Mehr davon",
      "row.discover.fresh": "Frisch erschienen",
      "row.discover.hunt": "Performer-Jagd",
      "row.discover.shortlist": "Deine Merkliste",
      "source.discover": "Curator + StashDB",
      "discover.shuffle": "🎲 Discover neu mischen",
      "discover.shuffle.title": "Jedes Modul zieht etwas anderes",
      "discover.reroll": "🎲 Andere",
      "discover.reroll.title": "Andere zeigen",
      "discover.next": "↻ Nächster Fund",
      "discover.notReady": "Curator baut seinen StashDB-Katalog für Discover noch auf.",
      "discover.build": "Jetzt aufbauen",
      "discover.building": "Gestartet. Das dauert ein paar Minuten; danach füllt sich Discover.",
      "discover.like.library": "In deiner Bibliothek",
      "discover.like.box": "Auf StashDB",
      "discover.like.none": "Noch nichts Ähnliches.",
      "discover.hunt.search": "Beliebige Performer auf StashDB suchen…",
      "discover.hunt.loading": "Curator durchkämmt die Szenen von {name} auf StashDB…",
      "discover.hunt.empty": "Nichts von {name}, das du noch nicht hast.",
      "discover.hunt.none": "Wähle einen Performer für die Jagd oder such auf StashDB.",
      "discover.hunt.go": "🏹 Jagen",
      "discover.hunt.go.title": "Zeigt ihre Szenen in der Performer-Jagd",
      "discover.teaser": "Curator hat auf StashDB Szenen gefunden, die zu deinem Geschmack passen.",
      "discover.teaser.open": "Discover öffnen →",
      "action.shortlist.title": "Auf die Merkliste",
      "action.unshortlist.title": "Von der Merkliste nehmen",
      "action.dismiss.title": "Kein Interesse: wird nicht mehr vorgeschlagen",
      "bubble.open.title": "{count} ungesehene zeigen",
      "bubble.panel": "{name}: {count} ungesehen",
      "bubble.panel.all": "Alle Szenen von {name} →",
      "action.close": "Schließen",
      "radar.next": "🎲 Jemand anderes",
      "radar.next.title": "Ein anderer Performer von deinem Radar ({count} insgesamt)",
      "radar.divider": "Nicht in deiner Sammlung",
      "radar.favourite": "★ Favorit",
      "radar.remove": "✕ Vom Radar",
      "radar.added": "{name} ist jetzt auf deinem Radar",
      "radar.removed": "{name} ist nicht mehr auf deinem Radar",
      "radar.favourited": "{name} ist jetzt ein Favorit",
      "radar.empty": "Nichts Neues: In deiner Bibliothek hast du alles gesehen, und auf StashDB fehlt dir nichts.",
      "action.download": "Herunterladen",
      "action.download.title": "Öffnet die Szene auf StashDB und sucht mit stasharr in Prowlarr",
      "badge.owned": "✓ In deiner Bibliothek",
      "spotlight.curator": "Curators bester Treffer",
      "spotlight.local": "Aus deinen Bestbewerteten",
      "spotlight.random": "Tipp des Tages",
      "customise.title": "Stashboard anpassen",
      "customise.hint": "Wähle, was auf der Startseite steht und in welcher Reihenfolge. Wird in Stash gespeichert und gilt in jedem Browser.",
      "customise.unsupported": "Hier nicht unterstützt (nur {known}): {names}",
      "customise.noBoxes": "Trage StashDB unter Einstellungen → Metadatenanbieter → Stash-Box-Endpunkte ein, um dessen Zeilen zu bekommen.",
      "notice.oldCurator": "Stash Curator steckt jetzt in Stashboard. Deinstalliere das separate Plugin Stash Curator (Einstellungen → Plugins), sonst läuft Curator doppelt. Deine Curator-Daten wurden übernommen.",
      "error.noKey": "{box} braucht einen gültigen API-Key: Einstellungen → Metadatenanbieter → Stash-Box-Endpunkte.",
      "error.row": "Diese Zeile konnte nicht geladen werden: {message}",
      "error.curatorModel": "Curator hat noch keine Empfehlungen. Starte in Curator „Sync and build recommendations“."
    }
  };

  function langOf(stashLanguage) {
    const base = String(stashLanguage || "en").toLowerCase().split(/[-_]/)[0];
    return STRINGS[base] ? base : "en";
  }

  function t(lang, key, vars) {
    const text = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
    return text.replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] != null ? String(vars[name]) : m));
  }

  // The heading of a row; tag/studio rows name the day's pick.
  function rowTitle(lang, id, env, picked) {
    const row = parseRowId(id);
    if (!row) return id;
    if (row.source === "spotlight") return t(lang, "row.spotlight");
    if (row.source === "radar") return t(lang, "row.radar");
    if (row.source === "bubbles") return t(lang, "row.bubbles");
    if (row.source === "local") {
      if ((row.kind === "tag_of_the_day" || row.kind === "studio_spotlight") && !picked) return t(lang, `row.local.${row.kind}.plain`);
      return t(lang, `row.local.${row.kind}`, { name: picked && picked.name });
    }
    if (row.source === "curator") return t(lang, `row.curator.${row.lane}`);
    if (row.source === "discover") return t(lang, row.kind === "like" && !picked ? "row.discover.like.plain" : `row.discover.${row.kind}`, { name: picked && picked.name });
    const box = (env.boxes || []).find((b) => b.host === row.host);
    return t(lang, `row.box.${row.kind}`, { box: box ? box.name : row.host });
  }

  function sceneTitle(scene) {
    const file = scene && scene.files && scene.files[0];
    return (scene && scene.title) || (file && file.basename) || `#${scene && scene.id}`;
  }

  // How far into the scene playback stopped (0–1), and the minutes left.
  function sceneProgress(scene) {
    const duration = scene && scene.files && scene.files[0] && scene.files[0].duration;
    if (!duration || !(scene.resume_time > 0)) return null;
    return Math.min(1, scene.resume_time / duration);
  }

  function minutesLeft(scene) {
    const duration = scene && scene.files && scene.files[0] && scene.files[0].duration;
    if (!duration || !(scene.resume_time > 0)) return null;
    return Math.max(1, Math.round((duration - scene.resume_time) / 60));
  }

  // Whole local days between a timestamp and now.
  function daysAgo(time, now) {
    if (!time) return null;
    const then = new Date(time);
    if (Number.isNaN(then.getTime())) return null;
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.max(0, Math.round((day(new Date(now)) - day(then)) / 86400000));
  }

  function whenText(lang, time, now) {
    const days = daysAgo(time, now);
    if (days == null) return "";
    if (days === 0) return t(lang, "when.today");
    if (days === 1) return t(lang, "when.yesterday");
    return t(lang, "when.days", { days });
  }

  // Ratings are stored out of 100 and shown out of 5, like Stash does.
  function stars(rating100) {
    return rating100 ? String(Math.round(rating100 / 2) / 10) : "";
  }

  /* ------------------------------------------------------------------ *
   * Performer bubbles                                                   *
   * ------------------------------------------------------------------ */

  const BUBBLES_MAX = 16;

  // One request for every performer's unwatched scene count, as aliases
  // p0, p1, … (performer ids are digits; JSON keeps them quoted anyway).
  function unwatchedCountsQuery(ids) {
    const parts = ids.map((id, i) =>
      `p${i}: findScenes(scene_filter: { performers: { value: [${JSON.stringify(String(id))}], modifier: INCLUDES }, play_count: { value: 0, modifier: EQUALS } }, filter: { per_page: 1 }) { count }`);
    return `query StashboardUnwatched {\n  ${parts.join("\n  ")}\n}`;
  }

  // Favourites and radar performers, once each (favourites first), with
  // their unwatched counts: the ones with something new first, most first.
  function bubbleOrder(favourites, radar, counts) {
    const seen = new Set();
    const people = [];
    for (const p of [...(favourites || []), ...(radar || [])]) {
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      people.push(p);
    }
    return people.slice(0, BUBBLES_MAX)
      .map((p, i) => ({ ...p, radar: !!radarSince(p), unwatched: (counts && counts[`p${i}`] && counts[`p${i}`].count) || 0, order: i }))
      .sort((a, b) => (b.unwatched > 0) - (a.unwatched > 0) || b.unwatched - a.unwatched || a.order - b.order);
  }

  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return "";
    const s = Math.round(seconds);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
  }

  const api = {
    PLUGIN_ID, OLD_CURATOR_ID, CURATOR_TAKEN, KNOWN_BOXES, boxFromConfig, usableBoxes,
    LOCAL_ROWS, CURATOR_LANES, BOX_ROWS, DEFAULT_ON, MODULES, moduleSize, THEMES, moduleTheme, UPNEXT_TOTAL, TAG_CHIPS, ZONES, rowZone, byZone, availableRows, parseRowId, defaultLayout,
    resolveLayout, visibleRows, readSettings, serializeLayout,
    dayKey, hashSeed, rowSeed, isoDate,
    REDISCOVER_DAYS, CONTINUE_OVERFETCH, pastWatched, localRowQuery, PICK_MIN_SCENES, pickQuery, localRowLink,
    BOX_SCENES_QUERY, BOX_PERFORMERS_MAX, boxRowInput, followedPerformerIds, pickImage, normalizeBoxScene,
    ownedMap, applyOwnership, STASHARR_ATTRIBUTE, STASHARR_HASH, downloadLink,
    RADAR_FIELD, RADAR_DECISION_PLAYS, localIsoDate, radarSince, radarDays, radarPick,
    radarDecisionDue, radarLocalQuery, radarBoxInput, radarBox, curatorHuntCards,
    DISCOVER_ROWS, stashdbBox, expandReady, expandCards, portraitImage, expandPerformers, similarSceneIds,
    DISCOVER_PAGES, discoverPage, seededPick, huntTargets, TAB_PARAM, tabOf, tabSearch,
    CACHE_PREFIX, cacheGet, cacheSet, cacheClear,
    oldCuratorEnabled, takeOverCuratorSettings, curatorSceneIds, orderByIds,
    STRINGS, langOf, t, rowTitle, formatDuration, sceneTitle, sceneProgress, minutesLeft, daysAgo, whenText, stars,
    BUBBLES_MAX, unwatchedCountsQuery, bubbleOrder
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StashboardCore = api;
})(typeof window !== "undefined" ? window : globalThis);
