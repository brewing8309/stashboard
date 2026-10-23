/*
 * Stashboard core: the pure logic behind the dashboard — the row catalogue,
 * layouts, query building, daily seeds, caching and texts. No DOM, no React,
 * no network: stashboard.js does all of that. Loaded first (see
 * stashboard.yml) and required directly by the tests in tests/.
 */
(function (root) {
  "use strict";

  const PLUGIN_ID = "stashboard";
  const CURATOR_PLUGIN_ID = "stash-curator";

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

  // Rows on by default, in this order. Rows of other kinds are available but
  // start switched off. Box rows apply to the first usable stash-box only.
  const DEFAULT_ON = [
    "spotlight",
    "local:continue",
    "curator:for_you",
    "local:recently_added",
    "box:*:favorites",
    "box:*:trending",
    "local:unwatched_favorites",
    "curator:best_bets",
    "local:tag_of_the_day",
    "box:*:performers",
    "local:rediscover",
    "local:studio_spotlight",
    "curator:revisit",
    "local:top_rated",
    "local:random"
  ];

  // Every row id that can be shown with what's available right now.
  function availableRows(env) {
    const ids = ["spotlight", ...LOCAL_ROWS.map((r) => `local:${r}`)];
    if (env.curator) ids.push(...CURATOR_LANES.map((l) => `curator:${l}`));
    if (!env.disableExternal) {
      for (const box of env.boxes || []) ids.push(...BOX_ROWS.map((k) => `box:${box.host}:${k}`));
    }
    return ids;
  }

  function parseRowId(id) {
    const parts = String(id).split(":");
    if (parts[0] === "spotlight" && parts.length === 1) return { source: "spotlight" };
    if (parts[0] === "local" && parts.length === 2 && LOCAL_ROWS.includes(parts[1])) return { source: "local", kind: parts[1] };
    if (parts[0] === "curator" && parts.length === 2 && CURATOR_LANES.includes(parts[1])) return { source: "curator", lane: parts[1] };
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
  // `layout` is written by the customise dialog as a JSON string.
  function readSettings(map) {
    const m = map || {};
    let layout = null;
    if (typeof m.layout === "string" && m.layout.trim()) {
      try {
        const parsed = JSON.parse(m.layout);
        if (Array.isArray(parsed)) layout = parsed;
      } catch (e) { /* broken value: fall back to the default layout */ }
    }
    return {
      hideNativeRows: m.hideNativeRows === true,
      disableExternal: m.disableExternal === true,
      hideOwned: m.hideOwned === true,
      cacheHours: clampNumber(m.cacheHours, 6, 0, 168),
      itemsPerRow: Math.round(clampNumber(m.itemsPerRow, 12, 4, 40)),
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
      case "random":
        return { filter: { per_page: per, sort: random } };
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
  function pickQuery(kind, seed) {
    const filter = { per_page: 1, sort: `random_${seed}` };
    const count = { scene_count: { value: PICK_MIN_SCENES - 1, modifier: "GREATER_THAN" } };
    if (kind === "tag_of_the_day") {
      return { query: "query StashboardPickTag($filter: FindFilterType, $f: TagFilterType) { findTags(filter: $filter, tag_filter: $f) { tags { id name } } }",
        variables: { filter, f: count }, path: ["findTags", "tags"] };
    }
    if (kind === "studio_spotlight") {
      return { query: "query StashboardPickStudio($filter: FindFilterType, $f: StudioFilterType) { findStudios(filter: $filter, studio_filter: $f) { studios { id name } } }",
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
  // row follows: favourites first, then the most collected.
  function followedPerformerIds(performers, endpoint) {
    const ordered = (performers || []).slice().sort((a, b) => (b.favorite === true) - (a.favorite === true));
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

  function curatorAvailable(plugins) {
    return (plugins || []).some((p) => p && p.id === CURATOR_PLUGIN_ID && p.enabled);
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
      "row.local.continue": "Continue watching",
      "row.local.recently_added": "Recently added",
      "row.local.unwatched_favorites": "Unwatched with your favourites",
      "row.local.tag_of_the_day": "Tag of the day: {name}",
      "row.local.tag_of_the_day.plain": "Tag of the day",
      "row.local.rediscover": "Not watched in a while",
      "row.local.studio_spotlight": "Studio spotlight: {name}",
      "row.local.studio_spotlight.plain": "Studio spotlight",
      "row.local.top_rated": "Top rated",
      "row.local.random": "Random picks",
      "row.curator.for_you": "For you",
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
      "action.scrollLeft": "Scroll left",
      "action.scrollRight": "Scroll right",
      "badge.owned": "✓ In your library",
      "spotlight.curator": "Curator's best bet",
      "spotlight.local": "From your top rated",
      "spotlight.random": "Today's pick",
      "customise.title": "Customise Stashboard",
      "customise.hint": "Choose rows and their order. Saved in Stash, so it applies to every browser.",
      "customise.unsupported": "Not supported here (only {known}): {names}",
      "customise.noBoxes": "Add StashDB under Settings → Metadata Providers → Stash-box Endpoints to get its rows.",
      "customise.noCurator": "Install the Stash Curator plugin for personal recommendation rows.",
      "error.noKey": "{box} needs a valid API key: Settings → Metadata Providers → Stash-box Endpoints.",
      "error.row": "Couldn't load this row: {message}",
      "error.curatorModel": "Curator has no recommendations yet. Run “Sync and build recommendations” in Curator."
    },
    de: {
      "row.spotlight": "Im Rampenlicht",
      "row.local.continue": "Weiterschauen",
      "row.local.recently_added": "Neu hinzugefügt",
      "row.local.unwatched_favorites": "Ungesehen mit deinen Favoriten",
      "row.local.tag_of_the_day": "Tag des Tages: {name}",
      "row.local.tag_of_the_day.plain": "Tag des Tages",
      "row.local.rediscover": "Lange nicht gesehen",
      "row.local.studio_spotlight": "Studio im Rampenlicht: {name}",
      "row.local.studio_spotlight.plain": "Studio im Rampenlicht",
      "row.local.top_rated": "Bestbewertet",
      "row.local.random": "Zufallsauswahl",
      "row.curator.for_you": "Für dich",
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
      "action.scrollLeft": "Nach links",
      "action.scrollRight": "Nach rechts",
      "badge.owned": "✓ In deiner Bibliothek",
      "spotlight.curator": "Curators bester Treffer",
      "spotlight.local": "Aus deinen Bestbewerteten",
      "spotlight.random": "Tipp des Tages",
      "customise.title": "Stashboard anpassen",
      "customise.hint": "Zeilen und Reihenfolge wählen. Wird in Stash gespeichert und gilt in jedem Browser.",
      "customise.unsupported": "Hier nicht unterstützt (nur {known}): {names}",
      "customise.noBoxes": "Trage StashDB unter Einstellungen → Metadatenanbieter → Stash-Box-Endpunkte ein, um dessen Zeilen zu bekommen.",
      "customise.noCurator": "Installiere das Plugin Stash Curator für persönliche Empfehlungszeilen.",
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
    if (row.source === "local") {
      if ((row.kind === "tag_of_the_day" || row.kind === "studio_spotlight") && !picked) return t(lang, `row.local.${row.kind}.plain`);
      return t(lang, `row.local.${row.kind}`, { name: picked && picked.name });
    }
    if (row.source === "curator") return t(lang, `row.curator.${row.lane}`);
    const box = (env.boxes || []).find((b) => b.host === row.host);
    return t(lang, `row.box.${row.kind}`, { box: box ? box.name : row.host });
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
    PLUGIN_ID, CURATOR_PLUGIN_ID, KNOWN_BOXES, boxFromConfig, usableBoxes,
    LOCAL_ROWS, CURATOR_LANES, BOX_ROWS, DEFAULT_ON, availableRows, parseRowId, defaultLayout,
    resolveLayout, visibleRows, readSettings, serializeLayout,
    dayKey, hashSeed, rowSeed, isoDate,
    REDISCOVER_DAYS, localRowQuery, PICK_MIN_SCENES, pickQuery, localRowLink,
    BOX_SCENES_QUERY, BOX_PERFORMERS_MAX, boxRowInput, followedPerformerIds, pickImage, normalizeBoxScene,
    ownedMap, applyOwnership,
    CACHE_PREFIX, cacheGet, cacheSet, cacheClear,
    curatorAvailable, curatorSceneIds, orderByIds,
    STRINGS, langOf, t, rowTitle, formatDuration
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StashboardCore = api;
})(typeof window !== "undefined" ? window : globalThis);
