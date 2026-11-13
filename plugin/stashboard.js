/*
 * Stashboard: a dashboard for Stash's front page. A grid of modules from
 * the library (up next, your performers, the day's tag, …), from the Stash
 * Curator plugin when it's installed, and from the stash-boxes set up in
 * Stash (trending on StashDB, new from your favourites, …).
 *
 * The logic lives in stashboard-core.js (window.StashboardCore); this file
 * does the talking (Stash GraphQL, stash-boxes, Curator) and the React UI.
 * It replaces the FrontPage component and keeps Stash's own front page
 * rows below the dashboard unless they're switched off. Whatever goes
 * wrong in here, the front page falls back to Stash's own.
 */
(function () {
  "use strict";

  if (window.__stashboardLoaded) return;
  window.__stashboardLoaded = true;

  const Api = window.PluginApi;
  const Core = window.StashboardCore;
  if (!Api || !Core) {
    console.error("[Stashboard] PluginApi or stashboard-core.js is missing; not loading.");
    return;
  }

  const React = Api.React;
  const h = React.createElement;
  const { useState, useEffect, useRef, useCallback } = React;
  const { Link } = Api.libraries.ReactRouterDOM;
  const { Button, Modal, Form } = Api.libraries.Bootstrap;

  const LOG = "[Stashboard]";

  /* ------------------------------------------------------------------ *
   * Talking to Stash, stash-boxes and Curator                          *
   * ------------------------------------------------------------------ */

  // Respects a reverse-proxy prefix: Stash sets <base href> to it.
  function graphqlUrl() {
    return new URL("graphql", document.baseURI).href;
  }

  async function stashQuery(query, variables) {
    const res = await fetch(graphqlUrl(), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`Stash: HTTP ${res.status}`);
    if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
    return json.data;
  }

  // Just what the modules show of a scene.
  const SCENES_QUERY = `query StashboardScenes($filter: FindFilterType, $scene_filter: SceneFilterType, $ids: [ID!]) {
  findScenes(filter: $filter, scene_filter: $scene_filter, ids: $ids) {
    count
    scenes {
      id title date details rating100 resume_time play_count last_played_at created_at
      paths { screenshot preview }
      files { duration basename }
      studio { id name }
      performers { id name }
      tags { id name }
    }
  }
}`;

  async function findScenes(variables) {
    return (await stashQuery(SCENES_QUERY, variables)).findScenes;
  }

  class CodedError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  async function boxQuery(box, query, variables) {
    if (!box.apiKey) throw new CodedError("noKey");
    const res = await fetch(box.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ApiKey: box.apiKey },
      body: JSON.stringify({ query, variables })
    });
    if (res.status === 401 || res.status === 403) throw new CodedError("noKey");
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`${box.name}: HTTP ${res.status}`);
    if (json.errors && json.errors.length) {
      // A request without a key gets 200 and this error; a wrong key gets 401.
      if (/not authori[sz]ed/i.test(json.errors[0].message)) throw new CodedError("noKey");
      throw new Error(`${box.name}: ${json.errors[0].message}`);
    }
    return json.data;
  }

  async function curatorOperation(args) {
    const data = await stashQuery(
      `mutation StashboardCurator($args: Map!) { runPluginOperation(plugin_id: "${Core.CURATOR_PLUGIN_ID}", args: $args) }`,
      { args }
    );
    return data.runPluginOperation;
  }

  const ENV_QUERY = `query StashboardEnvironment {
  configuration {
    general { stashBoxes { endpoint api_key name } }
    interface { language }
    plugins(include: ["${Core.PLUGIN_ID}"])
  }
  plugins { id enabled }
}`;

  async function loadEnvironment() {
    const data = await stashQuery(ENV_QUERY);
    const raw = (data.configuration.plugins && data.configuration.plugins[Core.PLUGIN_ID]) || {};
    const settings = Core.readSettings(raw);
    const { boxes, unsupported } = Core.usableBoxes(data.configuration.general.stashBoxes);
    const env = {
      lang: Core.langOf(data.configuration.interface && data.configuration.interface.language),
      curator: Core.curatorAvailable(data.plugins),
      boxes,
      unsupported,
      disableExternal: settings.disableExternal
    };
    return { env, settings, raw, layout: Core.resolveLayout(settings.layout, env) };
  }

  async function saveSettings(raw, changes) {
    await stashQuery(
      `mutation StashboardSave($input: Map!) { configurePlugin(plugin_id: "${Core.PLUGIN_ID}", input: $input) }`,
      { input: { ...raw, ...changes } }
    );
  }

  function storage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function sessionNumber(key) {
    try {
      return parseInt(window.sessionStorage.getItem(key), 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setSessionNumber(key, value) {
    try {
      window.sessionStorage.setItem(key, String(value));
    } catch (e) { /* not kept across navigation then */ }
  }

  /* ------------------------------------------------------------------ *
   * Row data                                                            *
   * ------------------------------------------------------------------ */

  function dig(obj, path) {
    return path.reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  async function loadLocalRow(row, ctx) {
    let picked = null;
    const pick = Core.pickQuery(row.kind, ctx.seed);
    if (pick) {
      picked = (dig(await stashQuery(pick.query, pick.variables), pick.path) || [])[0] || null;
      if (!picked) return { scenes: [], picked };
    }
    const continuing = row.kind === "continue" && ctx.watchedPercent > 0;
    const count = continuing ? ctx.count * Core.CONTINUE_OVERFETCH : ctx.count;
    const variables = Core.localRowQuery(row.kind, { count, seed: ctx.seed, now: ctx.now, pickedId: picked && picked.id });
    if (!variables) return { scenes: [], picked };
    const result = await findScenes(variables);
    if (!continuing) return { scenes: result.scenes, picked, count: result.count };
    const done = result.scenes.filter((s) => Core.pastWatched(s, ctx.watchedPercent));
    done.forEach(markWatched);
    return { scenes: result.scenes.filter((s) => !done.includes(s)).slice(0, ctx.count), picked };
  }

  // Watched far enough: forget where playback stopped, and record a play
  // unless Stash already counted one.
  function markWatched(scene) {
    const query = scene.play_count > 0 ? RESET_RESUME_MUTATION : WATCHED_MUTATION;
    stashQuery(query, { id: scene.id })
      .catch((e) => console.warn(LOG, "Couldn't mark the scene as watched:", e));
  }

  async function loadCuratorRow(lane, ctx) {
    const output = await curatorOperation({ operation: "get_slate", lane, count: ctx.count, page: 1, draw_seed: `stashboard-${ctx.seed}` });
    const ids = Core.curatorSceneIds(output);
    if (!ids.length) return { scenes: [] };
    const result = await findScenes({ filter: { per_page: ids.length }, ids: ids.map(String) });
    return { scenes: Core.orderByIds(result.scenes, ids) };
  }

  const FOLLOWED_QUERY = `query StashboardFollowed($filter: FindFilterType, $f: PerformerFilterType) {
  findPerformers(filter: $filter, performer_filter: $f) { performers { id favorite custom_fields stash_ids { endpoint stash_id } } }
}`;

  // Favourites, performers on the radar, and the most collected — in that
  // order of priority (see followedPerformerIds).
  async function followedPerformers(box) {
    const linked = { stash_id_endpoint: { endpoint: box.endpoint, modifier: "NOT_NULL" } };
    const filter = { per_page: Core.BOX_PERFORMERS_MAX, sort: "scenes_count", direction: "DESC" };
    const lists = await Promise.all([
      stashQuery(FOLLOWED_QUERY, { filter, f: { ...linked, filter_favorites: true } }),
      stashQuery(FOLLOWED_QUERY, { filter, f: { ...linked, custom_fields: [{ field: Core.RADAR_FIELD, modifier: "NOT_NULL" }] } }),
      stashQuery(FOLLOWED_QUERY, { filter, f: linked })
    ]);
    return Core.followedPerformerIds(lists.flatMap((l) => l.findPerformers.performers), box.endpoint);
  }

  const OWNED_QUERY = `query StashboardOwned($f: SceneFilterType) {
  findScenes(scene_filter: $f, filter: { per_page: -1 }) { scenes { id stash_ids { endpoint stash_id } } }
}`;

  // Needs Stash 0.31+ (stash_ids_endpoint takes a list); older versions
  // just don't get the ✓.
  async function ownedScenes(box, ids) {
    if (!ids.length) return {};
    try {
      const data = await stashQuery(OWNED_QUERY, { f: { stash_ids_endpoint: { endpoint: box.endpoint, stash_ids: ids, modifier: "EQUALS" } } });
      return Core.ownedMap(data.findScenes.scenes, box.endpoint);
    } catch (e) {
      console.warn(LOG, "Couldn't check which scenes are already in the library:", e.message);
      return {};
    }
  }

  async function loadBoxRow(row, box, ctx) {
    // Ask for more when owned scenes get hidden, so the row stays full.
    // Not keyed by the mix: these rows aren't random, so New mix doesn't
    // need to ask the stash-box again.
    const want = ctx.hideOwned ? ctx.count * 2 : ctx.count;
    const key = `${box.host}:${row.kind}:${want}:${ctx.day}`;
    let cards = Core.cacheGet(storage(), key, ctx.cacheHours * 3600000, ctx.now);
    if (!cards) {
      let performerIds;
      if (row.kind === "performers") {
        performerIds = await followedPerformers(box);
        if (!performerIds.length) return { cards: [] };
      }
      const input = Core.boxRowInput(row.kind, { count: want, now: ctx.now, performerIds });
      const data = await boxQuery(box, Core.BOX_SCENES_QUERY, { input });
      cards = ((data.queryScenes && data.queryScenes.scenes) || []).map((s) => Core.normalizeBoxScene(s, box));
      Core.cacheSet(storage(), key, cards, ctx.now);
    }
    const owned = await ownedScenes(box, cards.map((c) => c.id));
    return { cards: Core.applyOwnership(cards, owned, ctx.hideOwned).slice(0, ctx.count) };
  }

  // A few picks, for ↻ Another pick.
  async function loadSpotlight(env, ctx) {
    const count = Core.moduleSize("spotlight").count;
    if (env.curator) {
      try {
        const { scenes } = await loadCuratorRow("best_bets", { ...ctx, count });
        if (scenes.length) return { scenes, reason: "spotlight.curator" };
      } catch (e) {
        console.warn(LOG, "Curator spotlight unavailable:", e.message);
      }
    }
    for (const [kind, reason] of [["top_rated", "spotlight.local"], ["random", "spotlight.random"]]) {
      const result = await findScenes(Core.localRowQuery(kind, { count, seed: ctx.seed, now: ctx.now }));
      if (result.scenes.length) return { scenes: result.scenes, reason };
    }
    return { scenes: [] };
  }

  async function loadUpNext(ctx) {
    const [started, recent] = await Promise.all([
      loadLocalRow({ kind: "continue" }, { ...ctx, count: Core.moduleSize("local:continue").count }),
      findScenes(Core.localRowQuery("recently_added", { count: Core.UPNEXT_TOTAL, seed: ctx.seed, now: ctx.now }))
    ]);
    const ids = new Set(started.scenes.map((s) => s.id));
    const fresh = recent.scenes.filter((s) => !ids.has(s.id)).slice(0, Math.max(1, Core.UPNEXT_TOTAL - started.scenes.length));
    return { scenes: started.scenes, fresh };
  }

  // The day's tags (the first is the tag of the day) and scenes of the one
  // chosen.
  async function loadTagTile(ctx, chosenId) {
    const pick = Core.pickQuery("tag_of_the_day", ctx.seed, Core.TAG_CHIPS);
    const tags = dig(await stashQuery(pick.query, pick.variables), pick.path) || [];
    const picked = tags.find((t) => t.id === chosenId) || tags[0] || null;
    if (!picked) return { tags, picked, scenes: [], count: 0 };
    const count = Core.moduleSize("local:tag_of_the_day").count;
    const result = await findScenes(Core.localRowQuery("tag_of_the_day", { count, seed: ctx.seed, now: ctx.now, pickedId: picked.id }));
    return { tags, picked, scenes: result.scenes, count: result.count };
  }

  async function loadStudioTile(ctx) {
    const pick = Core.pickQuery("studio_spotlight", ctx.seed);
    const picked = (dig(await stashQuery(pick.query, pick.variables), pick.path) || [])[0] || null;
    if (!picked) return { picked, scenes: [] };
    const query = Core.localRowQuery("studio_spotlight", { count: Core.moduleSize("local:studio_spotlight").count, seed: ctx.seed, now: ctx.now, pickedId: picked.id });
    const [result, unwatched] = await Promise.all([
      findScenes(query),
      findScenes({ filter: { per_page: 1 }, scene_filter: { ...query.scene_filter, play_count: { value: 0, modifier: "EQUALS" } } })
    ]);
    return { picked, scenes: result.scenes, unwatched: unwatched.count };
  }

  const BUBBLES_QUERY = `query StashboardBubbles($favourites: PerformerFilterType, $radar: PerformerFilterType, $filter: FindFilterType) {
  favourites: findPerformers(performer_filter: $favourites, filter: $filter) { performers { id name image_path custom_fields } }
  radar: findPerformers(performer_filter: $radar, filter: $filter) { performers { id name image_path custom_fields } }
}`;

  async function loadBubbles() {
    const data = await stashQuery(BUBBLES_QUERY, {
      favourites: { filter_favorites: true },
      radar: { custom_fields: [{ field: Core.RADAR_FIELD, modifier: "NOT_NULL" }] },
      filter: { per_page: Core.BUBBLES_MAX, sort: "scenes_count", direction: "DESC" }
    });
    // Without counts the order is the one asked in, which the counts' aliases
    // (p0, p1, …) then follow.
    const people = Core.bubbleOrder(data.favourites.performers, data.radar.performers, null);
    if (!people.length) return { people };
    const counts = await stashQuery(Core.unwatchedCountsQuery(people.map((p) => p.id)));
    return { people: Core.bubbleOrder(data.favourites.performers, data.radar.performers, counts) };
  }

  /* ------------------------------------------------------------------ *
   * Radar                                                               *
   * ------------------------------------------------------------------ */

  // Through Stash's own client and PerformerUpdate document: the answer
  // lands in Stash's cache, so the performer's cards, heart and page update
  // by themselves.
  async function updatePerformer(input) {
    const client = Api.utils.StashService.getClient();
    const res = await client.mutate({ mutation: Api.GQL.PerformerUpdateDocument, variables: { input } });
    return res.data.performerUpdate;
  }

  function setRadar(performerId, on) {
    return updatePerformer({
      id: performerId,
      custom_fields: on ? { partial: { [Core.RADAR_FIELD]: Core.localIsoDate(new Date()) } } : { remove: [Core.RADAR_FIELD] }
    });
  }

  function makeFavourite(performerId) {
    return updatePerformer({ id: performerId, favorite: true, custom_fields: { remove: [Core.RADAR_FIELD] } });
  }

  const RADAR_QUERY = `query StashboardRadar($f: PerformerFilterType) {
  findPerformers(performer_filter: $f, filter: { per_page: -1 }) {
    performers { id name image_path scene_count favorite custom_fields stash_ids { endpoint stash_id } }
  }
}`;

  async function radarPerformers() {
    const data = await stashQuery(RADAR_QUERY, { f: { custom_fields: [{ field: Core.RADAR_FIELD, modifier: "NOT_NULL" }] } });
    return data.findPerformers.performers;
  }

  const PLAYED_SINCE_QUERY = `query StashboardPlayedSince($f: SceneFilterType) {
  findScenes(scene_filter: $f, filter: { per_page: 1 }) { count }
}`;

  // Curator's Performer Hunt fetches the whole catalogue from StashDB and
  // can take a while; past this, the row uses StashDB's popularity instead.
  const HUNT_TIMEOUT_MS = 45000;

  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms); })
    ]).finally(() => clearTimeout(timer));
  }

  async function radarBoxCards(linked, env, ctx) {
    const { box, stashId } = linked;
    const want = ctx.count * 2;
    const byCurator = env.curator && box.host === "stashdb.org";
    const key = `radar:${box.host}:${stashId}:${want}:${ctx.day}:${byCurator ? "curator" : "popular"}`;
    let cards = Core.cacheGet(storage(), key, ctx.cacheHours * 3600000, ctx.now);
    if (!cards) {
      if (byCurator) {
        try {
          const output = await withTimeout(curatorOperation({ operation: "get_performer_hunt", performer_id: stashId }), HUNT_TIMEOUT_MS);
          cards = Core.curatorHuntCards(output, box).slice(0, want);
        } catch (e) {
          console.warn(LOG, "Curator's Performer Hunt unavailable, using StashDB's popularity:", e.message);
        }
      }
      if (!cards || !cards.length) {
        const data = await boxQuery(box, Core.BOX_SCENES_QUERY, { input: Core.radarBoxInput(stashId, { count: want, now: ctx.now }) });
        cards = ((data.queryScenes && data.queryScenes.scenes) || []).map((s) => Core.normalizeBoxScene(s, box));
      }
      Core.cacheSet(storage(), key, cards, ctx.now);
    }
    // Scenes already in the library show in the library part (if unwatched).
    const owned = await ownedScenes(box, cards.map((c) => c.id));
    return Core.applyOwnership(cards, owned, true).slice(0, ctx.count);
  }

  async function loadRadarRow(performer, env, ctx) {
    const since = Core.radarSince(performer);
    const [local, played] = await Promise.all([
      findScenes(Core.radarLocalQuery(performer.id, ctx)),
      stashQuery(PLAYED_SINCE_QUERY, { f: {
        performers: { value: [performer.id], modifier: "INCLUDES" },
        last_played_at: { value: since, modifier: "GREATER_THAN" }
      } })
    ]);
    const linked = env.disableExternal ? null : Core.radarBox(performer, env.boxes);
    let cards = [];
    let boxError = null;
    if (linked) {
      try {
        cards = await radarBoxCards(linked, env, ctx);
      } catch (e) {
        console.warn(LOG, "Radar row's stash-box part failed:", e);
        boxError = e;
      }
    }
    return { scenes: local.scenes, unwatched: local.count, cards, box: linked && linked.box, boxError, playedSince: played.findScenes.count };
  }

  // Stash's interface language, for components outside the dashboard.
  let languagePromise = null;
  function useLang() {
    const [lang, setLang] = useState("en");
    useEffect(() => {
      let current = true;
      if (!languagePromise) {
        languagePromise = stashQuery("query StashboardLanguage { configuration { interface { language } } }")
          .then((d) => Core.langOf(d.configuration.interface && d.configuration.interface.language), () => "en");
      }
      languagePromise.then((l) => current && setLang(l));
      return () => { current = false; };
    }, []);
    return lang;
  }

  // 📡 on performer cards and the performer page. Hidden for favourites,
  // unless one somehow is on the radar too (so it can be taken off).
  function RadarToggle({ performer, variant }) {
    const lang = useLang();
    const Toast = Api.hooks.useToast();
    const [busy, setBusy] = useState(false);
    if (!performer || !performer.id) return null;
    const since = Core.radarSince(performer);
    if (performer.favorite && !since) return null;

    const toggle = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setBusy(true);
      try {
        await setRadar(performer.id, !since);
        Toast.success(Core.t(lang, since ? "radar.removed" : "radar.added", { name: performer.name }));
      } catch (err) {
        Toast.error(err);
      } finally {
        setBusy(false);
      }
    };
    const title = since ? Core.t(lang, "radar.on.title", { date: since }) : Core.t(lang, "radar.add.title");
    if (variant === "card") {
      return h("button", {
        type: "button", disabled: busy, title, "aria-label": title, "aria-pressed": !!since, onClick: toggle,
        className: `btn stashboard-radar-card${since ? " is-on" : ""}`
      }, "📡");
    }
    return h("div", { className: "stashboard-radar-page" },
      h(Button, { variant: since ? "primary" : "secondary", size: "sm", disabled: busy, title, "aria-pressed": !!since, onClick: toggle, className: `stashboard-radar-button${since ? " is-on" : ""}` },
        Core.t(lang, since ? "radar.on" : "radar.add")));
  }

  // Runs `load` once the row is on (or near) screen; drops the answer if
  // the row has changed or gone meanwhile.
  function useRowData(load, key, active) {
    const [state, setState] = useState({ status: "idle" });
    useEffect(() => {
      if (!active) return undefined;
      let current = true;
      setState({ status: "loading" });
      load().then(
        (data) => current && setState({ status: "done", data }),
        (error) => {
          if (!current) return;
          console.warn(LOG, key, error);
          setState({ status: "error", error });
        }
      );
      return () => { current = false; };
      // `load` is rebuilt every render; `key` says when it really changed.
    }, [key, active]);
    return state;
  }

  function useNearScreen(ref) {
    const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
    useEffect(() => {
      if (near || !ref.current) return undefined;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      }, { rootMargin: "600px 0px" });
      observer.observe(ref.current);
      return () => observer.disconnect();
    }, [near]);
    return near;
  }

  /* ------------------------------------------------------------------ *
   * Building blocks                                                     *
   * ------------------------------------------------------------------ */

  class Boundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { failed: false };
    }

    static getDerivedStateFromError() {
      return { failed: true };
    }

    componentDidCatch(error) {
      console.error(LOG, this.props.name || "", error);
    }

    render() {
      if (this.state.failed) return this.props.fallback === undefined ? null : this.props.fallback;
      return this.props.children;
    }
  }

  // A module: a tile on the page, as wide as Core.moduleSize says. Modules
  // in a line grow to fill it when a neighbour has nothing to show.
  function Module({ id, sizeOf, title, href, label, extra, className, innerRef, children }) {
    const link = href ? h(Link, { to: href, className: "stashboard-view-all" }, label) : null;
    return h("section", {
      ref: innerRef,
      className: `stashboard-module stashboard-module-${id.replace(/[^a-z0-9]+/gi, "-")} ${className || ""}`,
      "data-row": id,
      style: { "--span": Core.moduleSize(sizeOf || id).span }
    },
      title || extra || link
        ? h("header", { className: "stashboard-module-head" },
          title ? h("h2", null, title) : h("span"),
          h("span", { className: "stashboard-module-extra" }, extra || null, link))
        : null,
      children);
  }

  // Nothing to show: takes no room.
  function Empty({ id, innerRef }) {
    return h("div", { ref: innerRef, className: "stashboard-row-empty", "data-row": id });
  }

  function Skeleton({ className }) {
    return h("div", { className: `stashboard-skeleton ${className || ""}` });
  }

  function sceneDuration(scene) {
    const file = (scene.files || [])[0];
    return file && file.duration;
  }

  function hideBroken(e) {
    e.currentTarget.style.visibility = "hidden";
  }

  // A scene's picture. Its preview plays while hovered, like on Stash's cards.
  function SceneThumb({ scene, className, autoplay, children }) {
    const [hover, setHover] = useState(false);
    const paths = scene.paths || {};
    const progress = Core.sceneProgress(scene);
    return h(Link, {
      to: `/scenes/${scene.id}${autoplay ? "?autoplay=true" : ""}`,
      className: `stashboard-thumb ${className || ""}`,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false)
    },
      paths.screenshot ? h("img", { src: paths.screenshot, alt: "", loading: "lazy", onError: hideBroken }) : null,
      hover && paths.preview ? h("video", { src: paths.preview, autoPlay: true, muted: true, loop: true, playsInline: true }) : null,
      children,
      progress != null ? h("span", { className: "stashboard-progress" }, h("i", { style: { width: `${Math.round(progress * 100)}%` } })) : null);
  }

  function Duration({ seconds }) {
    return seconds ? h("span", { className: "stashboard-duration" }, Core.formatDuration(seconds)) : null;
  }

  // A scene from the library, small: picture, title, studio and date.
  function MiniScene({ scene, meta }) {
    const line = meta != null ? meta : [scene.studio && scene.studio.name, scene.date].filter(Boolean).join(" · ");
    return h("div", { className: "stashboard-scene", "data-scene": scene.id },
      h(SceneThumb, { scene }, h(Duration, { seconds: sceneDuration(scene) })),
      h(Link, { to: `/scenes/${scene.id}`, className: "stashboard-scene-title", title: Core.sceneTitle(scene) }, Core.sceneTitle(scene)),
      line ? h("div", { className: "stashboard-scene-meta" }, line) : null);
  }

  // stasharr's version, once it has marked the page (it may do so after
  // the dashboard has rendered), or null.
  function useStasharr() {
    const read = () => document.documentElement.getAttribute(Core.STASHARR_ATTRIBUTE);
    const [version, setVersion] = useState(read);
    useEffect(() => {
      const update = () => setVersion(read());
      window.addEventListener("stasharr:ready", update);
      const observer = new MutationObserver(update);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: [Core.STASHARR_ATTRIBUTE] });
      update();
      return () => {
        window.removeEventListener("stasharr:ready", update);
        observer.disconnect();
      };
    }, []);
    return version;
  }

  // Clears where playback stopped and records a play now, so the scene
  // leaves "Continue watching" and counts as watched.
  const WATCHED_MUTATION = `mutation StashboardWatched($id: ID!) {
  sceneResetActivity(id: $id, reset_resume: true, reset_duration: false)
  sceneAddPlay(id: $id) { count }
}`;

  const RESET_RESUME_MUTATION = `mutation StashboardResetResume($id: ID!) {
  sceneResetActivity(id: $id, reset_resume: true, reset_duration: false)
}`;

  // Undoes the unfinished viewing: drops the play Stash recorded when it
  // started (the newest one) and where it stopped, so the scene is back to
  // how it was before. The play time added stays.
  const REMOVE_MUTATION = `mutation StashboardRemoveResume($id: ID!) {
  sceneResetActivity(id: $id, reset_resume: true, reset_duration: false)
  sceneDeletePlay(id: $id) { count }
}`;

  const CONTINUE_ACTIONS = {
    watched: { icon: "✓", query: () => WATCHED_MUTATION, className: "stashboard-watched", failed: "Couldn't mark the scene as watched:" },
    remove: {
      icon: "✕",
      query: (scene) => (scene.play_count > 0 ? REMOVE_MUTATION : RESET_RESUME_MUTATION),
      className: "stashboard-remove",
      failed: "Couldn't remove the scene from Continue watching:"
    }
  };

  function ContinueButton({ action, scene, lang, onDone }) {
    const spec = CONTINUE_ACTIONS[action];
    const [state, setState] = useState({ busy: false, error: null });
    const run = async () => {
      setState({ busy: true, error: null });
      try {
        await stashQuery(spec.query(scene), { id: scene.id });
        onDone(scene.id);
      } catch (e) {
        console.warn(LOG, spec.failed, e);
        setState({ busy: false, error: e.message || String(e) });
      }
    };
    return h("button", {
      type: "button",
      className: `stashboard-icon-button ${spec.className}${state.error ? " is-error" : ""}`,
      disabled: state.busy,
      title: state.error ? Core.t(lang, "error.row", { message: state.error }) : Core.t(lang, `action.${action}.title`),
      "aria-label": Core.t(lang, `action.${action}`),
      onClick: run
    }, state.error ? "!" : spec.icon);
  }

  // A stash-box scene. One you have links to your copy and says so; one
  // you don't carries the stash-box's label and, with stasharr, ⬇.
  function BoxCard({ card, box, lang, stasharr, compact }) {
    const owned = !!card.localId;
    const download = stasharr && !owned ? Core.downloadLink(card, box) : null;
    const meta = [card.performers.slice(0, 2).join(", "), card.date].filter(Boolean).join(" · ");
    const external = { href: card.url, target: "_blank", rel: "noopener noreferrer" };
    const thumb = [
      card.image ? h("img", { key: "i", src: card.image, alt: "", loading: "lazy", referrerPolicy: "no-referrer", onError: hideBroken }) : null,
      h(Duration, { key: "d", seconds: card.duration }),
      owned ? null : h("span", { key: "r", className: "stashboard-ext-ribbon" }, box.name)
    ];
    return h("div", { className: `stashboard-ext-card${owned ? " is-owned" : ""}` },
      owned
        ? h(Link, { to: `/scenes/${card.localId}`, className: "stashboard-ext-thumb" }, thumb)
        : h("a", { ...external, className: "stashboard-ext-thumb" }, thumb),
      h("div", { className: "stashboard-ext-body" },
        owned ? h(Link, { to: `/scenes/${card.localId}`, className: "stashboard-badge stashboard-badge-owned" }, Core.t(lang, "badge.owned")) : null,
        h("a", { ...external, className: "stashboard-ext-title", title: card.title }, card.title || "—"),
        meta ? h("div", { className: "stashboard-ext-meta", title: card.performers.join(", ") }, meta) : null,
        download
          ? h("a", { href: download, target: "_blank", rel: "noopener noreferrer", className: "btn btn-primary btn-sm stashboard-download", title: Core.t(lang, "action.download.title"), "aria-label": Core.t(lang, "action.download") },
            compact ? "⬇" : `⬇ ${Core.t(lang, "action.download")}`)
          : null));
  }

  // A line in a chart: place, picture, title, and ⬇ or ✓.
  function ChartItem({ card, rank, box, lang, stasharr }) {
    const owned = !!card.localId;
    const download = stasharr && !owned ? Core.downloadLink(card, box) : null;
    const external = { href: card.url, target: "_blank", rel: "noopener noreferrer" };
    const meta = [card.studio, card.performers.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
    const thumb = card.image ? h("img", { src: card.image, alt: "", loading: "lazy", referrerPolicy: "no-referrer", onError: hideBroken }) : null;
    return h("div", { className: `stashboard-ext-card stashboard-chart-item${owned ? " is-owned" : ""}` },
      h("span", { className: "stashboard-chart-rank" }, rank),
      owned
        ? h(Link, { to: `/scenes/${card.localId}`, className: "stashboard-ext-thumb" }, thumb)
        : h("a", { ...external, className: "stashboard-ext-thumb" }, thumb),
      h("div", { className: "stashboard-ext-body" },
        h("a", { ...external, className: "stashboard-ext-title", title: card.title }, card.title || "—"),
        owned
          ? h(Link, { to: `/scenes/${card.localId}`, className: "stashboard-badge stashboard-badge-owned" }, Core.t(lang, "badge.owned"))
          : meta ? h("div", { className: "stashboard-ext-meta" }, meta) : null),
      download
        ? h("a", { href: download, target: "_blank", rel: "noopener noreferrer", className: "btn btn-primary btn-sm stashboard-download", title: Core.t(lang, "action.download.title"), "aria-label": Core.t(lang, "action.download") }, "⬇")
        : h("span"));
  }

  function RowMessage({ text }) {
    return h("div", { className: "stashboard-row-message" }, text);
  }

  function errorText(error, lang, box) {
    if (error && error.code === "noKey") return Core.t(lang, "error.noKey", { box: box ? box.name : "" });
    const message = (error && error.message) || String(error);
    if (/model|no recommendations|not ready|sync/i.test(message) && !box) return Core.t(lang, "error.curatorModel");
    return Core.t(lang, "error.row", { message });
  }

  /* ------------------------------------------------------------------ *
   * Modules                                                             *
   * ------------------------------------------------------------------ */

  // Loads once the module comes near the screen.
  function useModuleData(load, key) {
    const ref = useRef(null);
    const near = useNearScreen(ref);
    return { ref, state: useRowData(load, key, near) };
  }

  // The usual three states; `render` gets the data once there is some.
  function moduleBody(state, lang, box, render, skeleton) {
    if (state.status === "error") return h(RowMessage, { text: errorText(state.error, lang, box) });
    if (state.status !== "done") return h(Skeleton, { className: skeleton });
    return render(state.data);
  }

  // The big one on top: Curator's best bet, else one of your top rated,
  // else a random scene. ↻ goes to the next of a few picks.
  function Spotlight({ env, ctx }) {
    const seed = Core.rowSeed(ctx.day, "spotlight", ctx.mix);
    const state = useRowData(() => loadSpotlight(env, { ...ctx, seed }), `spotlight|${seed}|${ctx.refresh}`, true);
    const [index, setIndex] = useState(0);
    const scenes = (state.data && state.data.scenes) || [];
    const style = { "--span": Core.moduleSize("spotlight").span };
    if (state.status === "error" || (state.status === "done" && !scenes.length)) return h(Empty, { id: "spotlight" });
    if (!scenes.length) return h("section", { className: "stashboard-module stashboard-spotlight stashboard-spotlight-loading", "data-row": "spotlight", style });

    const lang = env.lang;
    const scene = scenes[index % scenes.length];
    const meta = [scene.studio && scene.studio.name, scene.date, Core.formatDuration(sceneDuration(scene))].filter(Boolean).join(" · ");
    const chips = [
      ...(scene.performers || []).slice(0, 2).map((p) => ({ key: `p${p.id}`, to: `/performers/${p.id}`, text: p.name })),
      ...(scene.tags || []).slice(0, 2).map((t) => ({ key: `t${t.id}`, to: `/tags/${t.id}`, text: t.name })),
      ...(scene.studio ? [{ key: "s", to: `/studios/${scene.studio.id}`, text: scene.studio.name }] : [])
    ];
    const image = scene.paths && scene.paths.screenshot;
    return h("section", { className: "stashboard-module stashboard-spotlight", "data-row": "spotlight", "data-scene": scene.id, style },
      image ? h("div", { className: "stashboard-spotlight-image", style: { backgroundImage: `url("${String(image).replace(/"/g, "%22")}")` } }) : null,
      h("div", { className: "stashboard-spotlight-shade" }),
      h("div", { className: "stashboard-spotlight-content" },
        h("span", { className: "stashboard-spotlight-reason" }, Core.t(lang, state.data.reason)),
        h("h2", { className: "stashboard-spotlight-title" }, h(Link, { to: `/scenes/${scene.id}` }, Core.sceneTitle(scene))),
        meta ? h("div", { className: "stashboard-spotlight-meta" }, meta) : null,
        scene.details ? h("p", { className: "stashboard-spotlight-details" }, scene.details) : null,
        h("div", { className: "stashboard-spotlight-actions" },
          h(Link, { to: `/scenes/${scene.id}?autoplay=true`, className: "btn btn-primary" }, `▶ ${Core.t(lang, "action.play")}`),
          h(Link, { to: `/scenes/${scene.id}`, className: "btn btn-secondary" }, Core.t(lang, "action.details")),
          scenes.length > 1
            ? h(Button, { variant: "secondary", className: "stashboard-spotlight-next", onClick: () => setIndex(index + 1) }, Core.t(lang, "action.nextPick"))
            : null),
        chips.length
          ? h("div", { className: "stashboard-chips" }, chips.map((c) => h(Link, { key: c.key, to: c.to, className: "stashboard-chip" }, c.text)))
          : null));
  }

  function UpNextItem({ scene, lang, now, children, sub }) {
    return h("div", { className: "stashboard-upnext-item stashboard-scene", "data-scene": scene.id },
      h(SceneThumb, { scene }, h(Duration, { seconds: children ? null : sceneDuration(scene) })),
      h("div", { className: "stashboard-upnext-text" },
        h(Link, { to: `/scenes/${scene.id}`, className: "stashboard-scene-title", title: Core.sceneTitle(scene) }, Core.sceneTitle(scene)),
        sub ? h("div", { className: "stashboard-upnext-left" }, sub) : null,
        h("div", { className: "stashboard-scene-meta" },
          children
            ? Core.whenText(lang, scene.last_played_at, now)
            : Core.t(lang, "upnext.added", { when: Core.whenText(lang, scene.created_at, now) }))),
      children ? h("div", { className: "stashboard-continue-actions" }, children) : null);
  }

  // Continue watching, short: where you stopped and how long is left, with
  // ✓ and ✕; then what's new in the library.
  function UpNext({ id, env, ctx }) {
    const lang = env.lang;
    const [done, setDone] = useState([]);
    const { ref, state } = useModuleData(() => loadUpNext(ctx), `${id}|${ctx.refresh}|${ctx.watchedPercent}`);
    const data = state.data || {};
    const scenes = (data.scenes || []).filter((s) => !done.includes(s.id));
    const fresh = data.fresh || [];
    if (state.status === "done" && !scenes.length && !fresh.length) return h(Empty, { id, innerRef: ref });
    const onDone = (sceneId) => setDone((list) => [...list, sceneId]);
    return h(Module, { id, innerRef: ref, title: Core.rowTitle(lang, id, env, null), href: "/scenes?sortby=last_played_at&sortdir=desc", label: Core.t(lang, "action.viewAll") },
      moduleBody(state, lang, null, () => h("div", { className: "stashboard-upnext" },
        scenes.map((scene) => {
          const left = Core.minutesLeft(scene);
          return h(UpNextItem, { key: scene.id, scene, lang, now: ctx.now, sub: left ? Core.t(lang, "upnext.left", { minutes: left }) : Core.t(lang, "upnext.started") },
            ["watched", "remove"].map((action) => h(ContinueButton, { key: action, action, scene, lang, onDone })));
        }),
        fresh.length ? h("div", { className: "stashboard-upnext-label" }, Core.t(lang, "upnext.new")) : null,
        fresh.map((scene) => h(UpNextItem, { key: `n${scene.id}`, scene, lang, now: ctx.now })))));
  }

  // Favourites and radar performers as round faces; the number is how many
  // of their scenes you haven't watched.
  function Bubbles({ id, env, ctx }) {
    const lang = env.lang;
    const { ref, state } = useModuleData(loadBubbles, `${id}|${ctx.refresh}`);
    const people = (state.data && state.data.people) || [];
    if (state.status === "done" && !people.length) return h(Empty, { id, innerRef: ref });
    return h(Module, { id, innerRef: ref, title: Core.rowTitle(lang, id, env, null), href: "/performers?sortby=scenes_count&sortdir=desc", label: Core.t(lang, "action.viewAll") },
      moduleBody(state, lang, null, () => h("div", { className: "stashboard-bubbles" },
        people.map((p) => h(Link, {
          key: p.id,
          to: `/performers/${p.id}`,
          className: `stashboard-bubble${p.radar ? " is-radar" : ""}${p.unwatched ? "" : " is-seen"}`,
          "data-performer": p.id,
          title: p.unwatched ? Core.t(lang, "bubble.unwatched", { count: p.unwatched }) : Core.t(lang, "bubble.none")
        },
          h("span", { className: "stashboard-bubble-face" },
            p.image_path ? h("img", { src: p.image_path, alt: "", loading: "lazy", onError: hideBroken }) : null,
            p.unwatched ? h("span", { className: "stashboard-bubble-count" }, p.unwatched) : null),
          h("span", { className: "stashboard-bubble-name" }, `${p.radar ? "📡 " : ""}${p.name}`)))), "is-bubbles"));
  }

  // Curator's For you, as a top five with big numbers.
  function TopFive({ id, env, ctx }) {
    const lang = env.lang;
    const seed = Core.rowSeed(ctx.day, id, ctx.mix);
    const { ref, state } = useModuleData(() => loadCuratorRow("for_you", { ...ctx, seed, count: Core.moduleSize(id).count }), `${id}|${seed}|${ctx.refresh}`);
    const scenes = (state.data && state.data.scenes) || [];
    if (state.status === "done" && !scenes.length) return h(Empty, { id, innerRef: ref });
    return h(Module, { id, innerRef: ref, title: Core.rowTitle(lang, id, env, null) },
      moduleBody(state, lang, null, () => h("ol", { className: "stashboard-top" },
        scenes.map((scene, i) => h("li", { key: scene.id, className: "stashboard-scene stashboard-rank", "data-scene": scene.id },
          h("span", { className: "stashboard-rank-number", "aria-hidden": true }, i + 1),
          h(SceneThumb, { scene, className: "stashboard-rank-thumb" },
            h("span", { className: "stashboard-rank-caption" },
              h("span", { className: "stashboard-scene-title" }, Core.sceneTitle(scene)))))))));
  }

  // The tag of the day as a picture mosaic, with a few other tags to switch
  // to and 🎲 for others still.
  function TagTile({ id, env, ctx }) {
    const lang = env.lang;
    const [roll, setRoll] = useState(0);
    const [chosen, setChosen] = useState(null);
    const seed = Core.rowSeed(ctx.day, id, ctx.mix + roll * 1000);
    const { ref, state } = useModuleData(() => loadTagTile({ ...ctx, seed }, chosen), `${id}|${seed}|${chosen}|${ctx.refresh}`);
    const data = state.data || {};
    if (state.status === "done" && (!data.picked || !data.scenes.length)) return h(Empty, { id, innerRef: ref });
    return h(Module, {
      id, innerRef: ref,
      title: Core.rowTitle(lang, id, env, data.picked || null),
      href: data.picked ? `/tags/${data.picked.id}` : null,
      label: Core.t(lang, "tile.scenes", { count: data.count })
    },
      moduleBody(state, lang, null, () => h(React.Fragment, null,
        h("div", { className: `stashboard-mosaic is-${data.scenes.length}` },
          data.scenes.map((scene, i) => h("div", { key: scene.id, className: "stashboard-scene", "data-scene": scene.id },
            h(SceneThumb, { scene }, i === 0 ? h(Duration, { seconds: sceneDuration(scene) }) : null,
              h("span", { className: "stashboard-mosaic-caption" }, h("span", { className: "stashboard-scene-title" }, Core.sceneTitle(scene))))))),
        h("div", { className: "stashboard-chips" },
          data.tags.map((t) => h("button", {
            key: t.id, type: "button",
            className: `stashboard-chip${t.id === data.picked.id ? " is-on" : ""}`,
            onClick: () => setChosen(t.id)
          }, t.name)),
          h("button", {
            type: "button", className: "stashboard-chip stashboard-tag-roll",
            title: Core.t(lang, "action.otherTag.title"), "aria-label": Core.t(lang, "action.otherTag.title"),
            onClick: () => { setChosen(null); setRoll(roll + 1); }
          }, Core.t(lang, "action.otherTag"))))));
  }

  function StudioTile({ id, env, ctx }) {
    const lang = env.lang;
    const seed = Core.rowSeed(ctx.day, id, ctx.mix);
    const { ref, state } = useModuleData(() => loadStudioTile({ ...ctx, seed }), `${id}|${seed}|${ctx.refresh}`);
    const data = state.data || {};
    if (state.status === "done" && (!data.picked || !data.scenes.length)) return h(Empty, { id, innerRef: ref });
    const studio = data.picked;
    return h(Module, { id, innerRef: ref },
      moduleBody(state, lang, null, () => h(React.Fragment, null,
        h(Link, { to: `/studios/${studio.id}`, className: "stashboard-studio" },
          h("span", { className: "stashboard-studio-logo" },
            studio.image_path ? h("img", { src: studio.image_path, alt: "", loading: "lazy", onError: hideBroken }) : null,
            h("span", { className: "stashboard-studio-initials", "aria-hidden": true }, String(studio.name).slice(0, 4))),
          h("span", null,
            h("h2", null, Core.rowTitle(lang, id, env, null)),
            h("span", { className: "stashboard-studio-name" }, studio.name),
            h("span", { className: "stashboard-scene-meta" }, Core.t(lang, "studio.counts", { scenes: studio.scene_count, unwatched: data.unwatched })))),
        h("div", { className: "stashboard-thumbs" },
          data.scenes.map((scene) => h("div", { key: scene.id, className: "stashboard-scene", "data-scene": scene.id },
            h(SceneThumb, { scene }, h(Duration, { seconds: sceneDuration(scene) })),
            h("span", { className: "stashboard-scene-title stashboard-sr" }, Core.sceneTitle(scene))))))));
  }

  // Not watched in a while: one scene, as a question.
  function Memory({ id, env, ctx }) {
    const lang = env.lang;
    const seed = Core.rowSeed(ctx.day, id, ctx.mix);
    const { ref, state } = useModuleData(() => loadLocalRow({ kind: "rediscover" }, { ...ctx, seed, count: Core.moduleSize(id).count }), `${id}|${seed}|${ctx.refresh}`);
    const scene = state.data && state.data.scenes[0];
    if (state.status === "done" && !scene) return h(Empty, { id, innerRef: ref });
    return h(Module, { id, innerRef: ref, title: scene ? Core.t(lang, "memory.ago", { when: Core.whenText(lang, scene.last_played_at, ctx.now) }) : Core.rowTitle(lang, id, env, null) },
      moduleBody(state, lang, null, () => h("div", { className: "stashboard-memory stashboard-scene", "data-scene": scene.id },
        h(SceneThumb, { scene }, h(Duration, { seconds: sceneDuration(scene) })),
        h("div", { className: "stashboard-memory-text" },
          h(Link, { to: `/scenes/${scene.id}`, className: "stashboard-memory-ask" }, Core.t(lang, "memory.ask", { title: Core.sceneTitle(scene) })),
          h("span", { className: "stashboard-scene-title stashboard-sr" }, Core.sceneTitle(scene)),
          h("div", { className: "stashboard-scene-meta" },
            [scene.studio && scene.studio.name, scene.rating100 ? `★ ${Core.stars(scene.rating100)}` : null, Core.t(lang, "memory.plays", { count: scene.play_count })].filter(Boolean).join(" · ")),
          h(Link, { to: `/scenes/${scene.id}?autoplay=true`, className: "btn btn-primary btn-sm" }, Core.t(lang, "action.again"))))));
  }

  // One random scene you haven't started, kept secret until you press Go.
  function Surprise({ id, env, ctx }) {
    const lang = env.lang;
    const [roll, setRoll] = useState(0);
    const seed = Core.rowSeed(ctx.day, id, ctx.mix + roll * 1000);
    const { ref, state } = useModuleData(() => loadLocalRow({ kind: "random" }, { ...ctx, seed, count: 1 }), `${id}|${seed}|${ctx.refresh}`);
    const scene = state.data && state.data.scenes[0];
    if (state.status === "done" && !scene) return h(Empty, { id, innerRef: ref });
    const image = scene && scene.paths && scene.paths.screenshot;
    return h(Module, { id, innerRef: ref, className: "stashboard-surprise" },
      image ? h("div", { className: "stashboard-surprise-image", style: { backgroundImage: `url("${String(image).replace(/"/g, "%22")}")` } }) : null,
      moduleBody(state, lang, null, () => h("div", { className: "stashboard-surprise-content", "data-scene": scene.id },
        h("span", { className: "stashboard-surprise-dice", "aria-hidden": true }, "🎲"),
        h("h2", null, Core.t(lang, "surprise.title")),
        h("p", { className: "stashboard-scene-meta" }, Core.t(lang, "surprise.sub")),
        h("div", { className: "stashboard-surprise-actions" },
          h(Link, { to: `/scenes/${scene.id}?autoplay=true`, className: "btn btn-primary stashboard-surprise-go" }, Core.t(lang, "action.go")),
          h(Button, { variant: "secondary", className: "stashboard-surprise-roll", onClick: () => setRoll(roll + 1) }, Core.t(lang, "action.reroll"))))));
  }

  // Every other library or Curator module: four scenes.
  function SceneTile({ id, env, ctx }) {
    const lang = env.lang;
    const row = Core.parseRowId(id);
    const seed = Core.rowSeed(ctx.day, id, ctx.mix);
    const count = Core.moduleSize(id).count;
    const { ref, state } = useModuleData(
      () => (row.source === "curator" ? loadCuratorRow(row.lane, { ...ctx, seed, count }) : loadLocalRow(row, { ...ctx, seed, count })),
      `${id}|${seed}|${ctx.refresh}`);
    const data = state.data || {};
    if (state.status === "done" && !data.scenes.length) return h(Empty, { id, innerRef: ref });
    const href = row.source === "local" ? Core.localRowLink(row.kind, data.picked) : null;
    return h(Module, { id, innerRef: ref, title: Core.rowTitle(lang, id, env, data.picked || null), href, label: Core.t(lang, "action.viewAll") },
      moduleBody(state, lang, null, () => h("div", { className: "stashboard-tile" }, data.scenes.map((scene) => h(MiniScene, { key: scene.id, scene })))));
  }

  // Stash-box modules: trending as a chart, the others as four cards.
  function BoxModule({ id, env, ctx }) {
    const lang = env.lang;
    const row = Core.parseRowId(id);
    const box = env.boxes.find((b) => b.host === row.host);
    const stasharr = useStasharr();
    const count = Core.moduleSize(id).count;
    const { ref, state } = useModuleData(() => loadBoxRow(row, box, { ...ctx, count }), `${id}|${ctx.day}|${ctx.refresh}|${ctx.hideOwned}`);
    if (!box) return null;
    const cards = (state.data && state.data.cards) || [];
    if (state.status === "done" && !cards.length) return h(Empty, { id, innerRef: ref });
    const site = { href: box.site, target: "_blank", rel: "noopener noreferrer", className: "stashboard-view-all" };
    const chart = row.kind === "trending";
    return h(Module, { id, innerRef: ref, title: Core.rowTitle(lang, id, env, null), extra: h("a", site, `↗ ${box.name}`) },
      moduleBody(state, lang, box, () => (chart
        ? h("div", { className: "stashboard-chart" }, cards.map((card, i) => h(ChartItem, { key: card.id, card, rank: i + 1, box, lang, stasharr })))
        : h("div", { className: "stashboard-tile" }, cards.map((card) => h(BoxCard, { key: card.id, card, box, lang, stasharr }))))));
  }

  // A radar performer: portrait, how they're doing, and four scenes (first
  // what's in the library, then what isn't).
  function RadarProfile({ performer, count, env, ctx, decisionDays, onGone, onNext }) {
    const lang = env.lang;
    const stasharr = useStasharr();
    const Toast = Api.hooks.useToast();
    const [busy, setBusy] = useState(false);
    const id = `radar:${performer.id}`;
    const since = Core.radarSince(performer);
    const seed = Core.rowSeed(ctx.day, id, ctx.mix);
    const size = Core.moduleSize("radar").count;
    const { ref, state } = useModuleData(() => loadRadarRow(performer, env, { ...ctx, seed, count: size }), `${id}|${seed}|${ctx.refresh}`);
    if (!since) return null;

    const data = state.data || {};
    const days = Core.radarDays(since, ctx.now);
    const decide = state.status === "done" && Core.radarDecisionDue(days, data.playedSince || 0, decisionDays);
    const sinceText = decide
      ? Core.t(lang, "radar.decide", { date: since, plays: data.playedSince })
      : days === 0 ? Core.t(lang, "radar.since.today") : days === 1 ? Core.t(lang, "radar.since.one") : Core.t(lang, "radar.since", { days });
    const act = (fn, message) => async () => {
      setBusy(true);
      try {
        await fn(performer.id);
        Toast.success(Core.t(lang, message, { name: performer.name }));
        onGone(performer.id);
      } catch (e) {
        Toast.error(e);
        setBusy(false);
      }
    };
    const next = count > 1
      ? h("button", { type: "button", className: "stashboard-view-all stashboard-radar-next", disabled: busy, title: Core.t(lang, "radar.next.title", { count }), onClick: onNext }, Core.t(lang, "radar.next"))
      : null;

    return h(Module, { id, sizeOf: "radar", innerRef: ref, title: Core.rowTitle(lang, "radar", env, performer), extra: next, className: `stashboard-radar-row${decide ? " is-due" : ""}` },
      h("div", { className: "stashboard-radar" },
        h("div", { className: "stashboard-radar-profile" },
          h(Link, { to: `/performers/${performer.id}`, className: "stashboard-radar-portrait" },
            performer.image_path ? h("img", { src: performer.image_path, alt: "", loading: "lazy", onError: hideBroken }) : null),
          h("div", { className: "stashboard-radar-about" },
            h(Link, { to: `/performers/${performer.id}`, className: "stashboard-radar-name" }, performer.name),
            h("div", { className: `stashboard-radar-bar${decide ? " is-due" : ""}` }, sinceText),
            h("div", { className: "stashboard-radar-stats" },
              [[performer.scene_count, "radar.stat.here"], [data.unwatched, "radar.stat.unwatched"], [data.playedSince, "radar.stat.since"]].map(([n, key]) =>
                h("span", { key }, h("b", null, n == null ? "–" : n), Core.t(lang, key)))),
            h("div", { className: "stashboard-radar-actions" },
              h(Button, { variant: decide ? "primary" : "secondary", size: "sm", disabled: busy, className: "stashboard-radar-favourite", onClick: act(makeFavourite, "radar.favourited") }, Core.t(lang, "radar.favourite")),
              h(Button, { variant: "secondary", size: "sm", disabled: busy, className: "stashboard-radar-remove", onClick: act((pid) => setRadar(pid, false), "radar.removed") }, Core.t(lang, "radar.remove"))))),
        moduleBody(state, lang, data.box, () => {
          const missing = data.cards.filter((card) => !card.localId);
          const local = data.scenes.slice(0, missing.length ? Math.max(size - missing.length, size / 2) : size);
          const cards = missing.slice(0, size - local.length);
          if (!local.length && !cards.length) return h(RowMessage, { text: Core.t(lang, "radar.empty") });
          return h(React.Fragment, null,
            h("div", { className: "stashboard-radar-scenes" },
              local.map((scene) => h("div", { key: `l${scene.id}`, className: "stashboard-scene is-local", "data-scene": scene.id },
                h(SceneThumb, { scene }), h("span", { className: "stashboard-scene-title stashboard-sr" }, Core.sceneTitle(scene)))),
              cards.map((card) => h(BoxCard, { key: `b${card.id}`, card, box: data.box, lang, stasharr, compact: true }))),
            data.boxError ? h(RowMessage, { text: errorText(data.boxError, lang, data.box) }) : null);
        })));
  }

  const RADAR_LAST_KEY = "stashboard:radar-last";

  function readStored(key) {
    try {
      const store = storage();
      return store ? store.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      const store = storage();
      if (store) store.setItem(key, value);
    } catch (e) { /* not remembered then */ }
  }

  // One performer from the radar, a different one each time the page loads
  // (and on 🎲). The one shown last is remembered across visits.
  function RadarModule({ env, ctx, decisionDays }) {
    const state = useRowData(radarPerformers, `radar|${ctx.refresh}`, true);
    const [current, setCurrent] = useState(null);
    const [gone, setGone] = useState([]);
    const left = state.status === "done" ? state.data.filter((p) => Core.radarSince(p) && !gone.includes(p.id)) : [];
    const performer = left.find((p) => p.id === current) || null;
    const pick = (lastId) => {
      const next = Core.radarPick(left, lastId, Math.random());
      setCurrent(next ? next.id : null);
      if (next) writeStored(RADAR_LAST_KEY, next.id);
    };
    useEffect(() => {
      if (state.status === "done" && !performer && left.length) pick(current || readStored(RADAR_LAST_KEY));
    }, [state.status, performer, left.length]);
    if (!performer) return null;
    return h(Boundary, { key: performer.id, name: `radar ${performer.id}` },
      h(RadarProfile, {
        performer, count: left.length, env, ctx, decisionDays,
        onGone: (pid) => setGone((list) => [...list, pid]),
        onNext: () => pick(performer.id)
      }));
  }

  function moduleFor(id, env, ctx, settings) {
    const row = Core.parseRowId(id);
    if (row.source === "spotlight") return h(Spotlight, { env, ctx });
    if (row.source === "radar") return h(RadarModule, { env, ctx, decisionDays: settings.radarDecisionDays });
    if (row.source === "bubbles") return h(Bubbles, { id, env, ctx });
    if (row.source === "box") return h(BoxModule, { id, env, ctx });
    if (id === "curator:for_you") return h(TopFive, { id, env, ctx });
    const special = { continue: UpNext, tag_of_the_day: TagTile, studio_spotlight: StudioTile, rediscover: Memory, random: Surprise };
    if (row.source === "local" && special[row.kind]) return h(special[row.kind], { id, env, ctx });
    return h(SceneTile, { id, env, ctx });
  }

  /* ------------------------------------------------------------------ *
   * Customise dialog                                                    *
   * ------------------------------------------------------------------ */

  function sourceLabel(lang, id, env) {
    const row = Core.parseRowId(id);
    if (row.source === "curator") return Core.t(lang, "source.curator");
    if (row.source === "radar") return Core.t(lang, "source.radar");
    if (row.source === "box") {
      const box = env.boxes.find((b) => b.host === row.host);
      return Core.t(lang, "source.box", { box: box ? box.name : row.host });
    }
    return Core.t(lang, "source.local");
  }

  function Customise({ state, onClose, onSave }) {
    const { env } = state;
    const lang = env.lang;
    const available = new Set(Core.availableRows(env));
    const [rows, setRows] = useState(() => state.layout.map((r) => ({ ...r })));
    const [saving, setSaving] = useState(false);
    const shown = rows.filter((r) => available.has(r.id));

    // Rows move within their zone; the zones themselves stay in place.
    const move = (id, dir) => setRows((list) => {
      const visible = list.filter((r) => available.has(r.id) && Core.rowZone(r.id) === Core.rowZone(id));
      const i = visible.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= visible.length) return list;
      const next = list.slice();
      const a = next.indexOf(visible[i]);
      const b = next.indexOf(visible[j]);
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
    const toggle = (id) => setRows((list) => list.map((r) => (r.id === id ? { ...r, on: !r.on } : r)));
    const save = async () => {
      setSaving(true);
      try {
        await onSave(rows);
      } finally {
        setSaving(false);
      }
    };

    const hints = [];
    if (!env.boxes.length && !env.disableExternal) hints.push(Core.t(lang, "customise.noBoxes"));
    if (env.unsupported.length) hints.push(Core.t(lang, "customise.unsupported", { known: Core.KNOWN_BOXES.map((b) => b.name).join(", "), names: env.unsupported.join(", ") }));
    if (!env.curator) hints.push(Core.t(lang, "customise.noCurator"));

    return h(Modal, { show: true, onHide: onClose, size: "lg", className: "stashboard-customise", scrollable: true },
      h(Modal.Header, { closeButton: true }, h(Modal.Title, null, Core.t(lang, "customise.title"))),
      h(Modal.Body, null,
        h("p", { className: "text-muted" }, Core.t(lang, "customise.hint")),
        hints.map((text, i) => h("p", { key: i, className: "stashboard-customise-hint" }, text)),
        Core.ZONES.map((zone) => {
          const inZone = shown.filter((r) => Core.rowZone(r.id) === zone);
          if (!inZone.length) return null;
          return h(React.Fragment, { key: zone },
            h("h6", { className: `stashboard-customise-zone is-${zone}` }, Core.t(lang, `zone.${zone}`)),
            h("ul", { className: "stashboard-customise-list", "data-zone": zone },
              inZone.map((r, i) => h("li", { key: r.id, className: r.on ? "" : "is-off", "data-row": r.id },
                h(Form.Check, {
                  type: "switch",
                  id: `stashboard-row-${r.id}`,
                  checked: r.on,
                  onChange: () => toggle(r.id),
                  label: Core.rowTitle(lang, r.id, env, null)
                }),
                h("span", { className: "stashboard-customise-source" }, sourceLabel(lang, r.id, env)),
                h("span", { className: "stashboard-customise-move" },
                  h(Button, { variant: "secondary", size: "sm", disabled: i === 0, title: Core.t(lang, "action.up"), "aria-label": Core.t(lang, "action.up"), onClick: () => move(r.id, -1) }, "↑"),
                  h(Button, { variant: "secondary", size: "sm", disabled: i === inZone.length - 1, title: Core.t(lang, "action.down"), "aria-label": Core.t(lang, "action.down"), onClick: () => move(r.id, 1) }, "↓"))))));
        })),
      h("div", { className: "stashboard-notice" },
        h("p", null, "Copyright 2026 brewing8309 — ", h("a", { href: "https://github.com/brewing8309/stashboard", target: "_blank", rel: "noopener noreferrer" }, "github.com/brewing8309/stashboard")),
        h("p", null, h("strong", null, "This software is vibecoded."), " It was written end to end by an AI (Claude) from natural-language prompts. No human wrote or reviewed the code by hand. It ships with automated tests but no warranty."),
        h("p", null, "Licensed under the PolyForm Noncommercial License 1.0.0 — free to use and modify for any noncommercial purpose; selling it is not permitted.")),
      h(Modal.Footer, null,
        h(Button, { variant: "outline-secondary", className: "mr-auto me-auto", onClick: () => setRows(Core.defaultLayout(env)) }, Core.t(lang, "action.reset")),
        h(Button, { variant: "secondary", onClick: onClose }, Core.t(lang, "action.cancel")),
        h(Button, { variant: "primary", disabled: saving, onClick: save, className: "stashboard-save" }, Core.t(lang, "action.save"))));
  }

  /* ------------------------------------------------------------------ *
   * The dashboard                                                       *
   * ------------------------------------------------------------------ */

  const MIX_KEY = "stashboard:mix";
  const DISCOVER_HIDDEN_KEY = "stashboard:discover-hidden";

  // Below the library: what isn't in it (yet), set apart so it doesn't mix
  // with what's there to watch. Can be folded away; that's remembered.
  function DiscoverZone({ lang, children }) {
    const [hidden, setHidden] = useState(() => readStored(DISCOVER_HIDDEN_KEY) === "1");
    const toggle = () => {
      writeStored(DISCOVER_HIDDEN_KEY, hidden ? "0" : "1");
      setHidden(!hidden);
    };
    return h("section", { className: `stashboard-discover${hidden ? " is-hidden" : ""}`, "data-zone": "discover" },
      h("header", { className: "stashboard-discover-head" },
        h("div", null,
          h("h2", { className: "stashboard-discover-title" }, Core.t(lang, "zone.discover")),
          h("p", { className: "stashboard-discover-sub" }, Core.t(lang, "zone.discover.sub"))),
        h(Button, { variant: "secondary", size: "sm", className: "stashboard-discover-toggle", "aria-expanded": !hidden, onClick: toggle },
          hidden ? `▾ ${Core.t(lang, "zone.show")}` : `▴ ${Core.t(lang, "zone.hide")}`)),
      hidden ? null : children);
  }

  function Dashboard({ onSettings }) {
    const [state, setState] = useState(null);
    const [failed, setFailed] = useState(null);
    const [mix, setMix] = useState(() => sessionNumber(MIX_KEY));
    const [refresh, setRefresh] = useState(0);
    const [customising, setCustomising] = useState(false);

    const reload = useCallback(() => {
      loadEnvironment().then((loaded) => {
        setState(loaded);
        onSettings(loaded.settings);
      }, (e) => {
        console.error(LOG, "Couldn't load Stashboard's settings:", e);
        setFailed(e);
      });
    }, []);
    useEffect(reload, []);

    if (failed) return null;
    if (!state) return h("div", { className: "stashboard stashboard-loading" });

    const { env, settings } = state;
    const lang = env.lang;
    const now = Date.now();
    const ctx = {
      day: Core.dayKey(new Date(now)),
      now,
      mix,
      refresh,
      hideOwned: settings.hideOwned,
      cacheHours: settings.cacheHours,
      watchedPercent: settings.watchedPercent
    };

    const newMix = () => {
      setMix(mix + 1);
      setSessionNumber(MIX_KEY, mix + 1);
    };
    const refreshAll = () => {
      Core.cacheClear(storage());
      setRefresh(refresh + 1);
    };
    const saveLayout = async (rows) => {
      await saveSettings(state.raw, { modules: Core.serializeLayout(rows) });
      setCustomising(false);
      reload();
    };

    const zones = Core.byZone(Core.visibleRows(state.layout, env));
    const renderRow = (id) => h(Boundary, { key: `${id}|${mix}|${refresh}`, name: id }, moduleFor(id, env, ctx, settings));
    return h("div", { className: "stashboard" },
      h("div", { className: "stashboard-toolbar" },
        h("span", { className: "stashboard-brand" }, "Stashboard"),
        h("span", { className: "stashboard-toolbar-actions" },
          h(Button, { variant: "secondary", size: "sm", onClick: newMix, className: "stashboard-mix" }, `🔀 ${Core.t(lang, "action.mix")}`),
          h(Button, { variant: "secondary", size: "sm", onClick: refreshAll, className: "stashboard-refresh" }, `⟳ ${Core.t(lang, "action.refresh")}`),
          h(Button, { variant: "secondary", size: "sm", onClick: () => setCustomising(true), className: "stashboard-customise-open" }, `⚙ ${Core.t(lang, "action.customise")}`))),
      zones.library.length ? h("div", { className: "stashboard-grid", "data-zone": "library" }, zones.library.map(renderRow)) : null,
      zones.discover.length ? h(DiscoverZone, { lang }, h("div", { className: "stashboard-grid" }, zones.discover.map(renderRow))) : null,
      customising ? h(Customise, { state, onClose: () => setCustomising(false), onSave: saveLayout }) : null);
  }

  // Stash's own front page, rendered as its own component so its hooks
  // live in their own fiber.
  function NativeFrontPage({ render, args }) {
    return render(...args);
  }

  // Shows Stash's own rows below the dashboard unless switched off. Until
  // the settings are in (and if Stashboard fails) they show.
  function FrontPage({ args, render }) {
    const [hideNative, setHideNative] = useState(false);
    const onSettings = useCallback((settings) => setHideNative(settings.hideNativeRows), []);
    return h("div", { className: "recommendations-container stashboard-front" },
      h(Boundary, { name: "dashboard", fallback: null }, h(Dashboard, { onSettings })),
      hideNative ? null : h("div", { className: "stashboard-native" }, h(NativeFrontPage, { render, args })));
  }

  // 📡 on every performer card (scene pages, performer lists) and on the
  // performer page, next to Stash's own controls.
  Api.patch.after("PerformerCard.Overlays", function (...args) {
    const result = args[args.length - 1];
    return h(React.Fragment, null, result,
      h(Boundary, { name: "radar on a card" }, h(RadarToggle, { performer: args[0] && args[0].performer, variant: "card" })));
  });

  Api.patch.after("PerformerDetailsPanel", function (...args) {
    const result = args[args.length - 1];
    return h(React.Fragment, null,
      h(Boundary, { name: "radar on the performer page" }, h(RadarToggle, { performer: args[0] && args[0].performer, variant: "page" })),
      result);
  });

  Api.patch.instead("FrontPage", function (...args) {
    const render = args[args.length - 1];
    const own = args.slice(0, -1);
    return h(Boundary, { name: "front page", fallback: h(NativeFrontPage, { render, args: own }) },
      h(FrontPage, { args: own, render }));
  });
})();
